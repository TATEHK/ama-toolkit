-- AMA ID Cards: tick-box permissions (replaces the single role per person)
-- Run once in Supabase > SQL Editor, after roles.sql (and printed.sql if you use it). Safe to run again.
--
-- Each person can have any mix of these, like Black Belt Prep:
--   admin     everything, including card design, settings, backups and users
--   edit      add people, edit their details, take photos, mark as printed, import
--   delete    delete people
--   send      send cards to print
--   approve   approve, cancel and retry print jobs
--   viewer    look at people and the print queue (anyone with another permission can look too)
--   printer   the laptop's print station login (prints jobs, reports its status)
-- No ticks = no access.
--
-- Everyone keeps what they could do before:
--   Admin -> admin;  Approver -> edit, delete, send, approve;  Photos -> edit;
--   Viewer -> viewer;  Print station -> printer;  No access -> nothing.
-- If jobs need approval, someone with "send" but not "approve" sends jobs that wait for an approver.

create table if not exists public.staff_permissions (
  email      text not null,
  permission text not null check (permission in ('admin', 'edit', 'delete', 'send', 'approve', 'viewer', 'printer')),
  created_at timestamptz not null default now(),
  primary key (email, permission)
);

-- Copy everyone's old role across (first run only)
insert into public.staff_permissions (email, permission)
select lower(r.email), p
from public.staff_roles r
cross join lateral unnest(case r.role
  when 'admin'    then array['admin']
  when 'approver' then array['edit', 'delete', 'send', 'approve']
  when 'photos'   then array['edit']
  when 'viewer'   then array['viewer']
  when 'printer'  then array['printer']
  else array[]::text[] end) as p
where not exists (select 1 from public.staff_permissions)
on conflict do nothing;

-- Does the signed-in person have any of these permissions? Admin counts as all of them.
create or replace function public.has_perm(variadic perms text[]) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from public.staff_permissions
                       where email = lower(auth.jwt() ->> 'email') and (permission = any(perms) or permission = 'admin')) $$;

create or replace function public.my_permissions() returns text[]
  language sql stable security definer set search_path = public
  as $$ select coalesce(array_agg(permission order by permission), '{}') from public.staff_permissions
        where email = lower(auth.jwt() ->> 'email') $$;

-- Looking only (any permission except the print station)
create or replace function public.can_view_cards() returns boolean
  language sql stable security definer set search_path = public
  as $$ select public.has_perm('viewer', 'edit', 'delete', 'send', 'approve') $$;

grant execute on function public.has_perm(text[]), public.my_permissions(), public.can_view_cards() to authenticated;

-- Older copies of the app still on someone's phone ask for a single role: give them the nearest one
create or replace function public.my_role() returns text
  language sql stable security definer set search_path = public
  as $$ select case
    when public.has_perm('admin') then 'admin'
    when exists (select 1 from public.staff_permissions where email = lower(auth.jwt() ->> 'email') and permission = 'approve') then 'approver'
    when exists (select 1 from public.staff_permissions where email = lower(auth.jwt() ->> 'email') and permission = 'edit') then 'photos'
    when exists (select 1 from public.staff_permissions where email = lower(auth.jwt() ->> 'email') and permission in ('viewer', 'delete', 'send')) then 'viewer'
    when exists (select 1 from public.staff_permissions where email = lower(auth.jwt() ->> 'email') and permission = 'printer') then 'printer'
  end $$;
create or replace function public.has_role(variadic roles text[]) returns boolean
  language sql stable security definer set search_path = public
  as $$ select public.my_role() = any(roles) $$;

-- Who can see and change permissions
alter table public.staff_permissions enable row level security;
drop policy if exists "see own or all as admin" on public.staff_permissions;
drop policy if exists "admins manage" on public.staff_permissions;
create policy "see own or all as admin" on public.staff_permissions for select to authenticated
  using (email = lower(auth.jwt() ->> 'email') or public.has_perm('admin'));
create policy "admins manage" on public.staff_permissions for all to authenticated
  using (public.has_perm('admin')) with check (public.has_perm('admin'));

-- Never leave the card software without an admin
create or replace function public.keep_a_card_admin() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if old.permission = 'admin' and (tg_op = 'DELETE' or new.permission <> 'admin' or new.email <> old.email) then
    if not exists (select 1 from public.staff_permissions where permission = 'admin' and email <> old.email) then
      raise exception 'There must always be at least one admin.';
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists staff_permissions_keep_admin on public.staff_permissions;
create trigger staff_permissions_keep_admin before update or delete on public.staff_permissions
  for each row execute function public.keep_a_card_admin();

-- Logins created directly in Supabase get the permissions chosen in the app (no access by default)
create or replace function public.role_for_new_login() returns trigger
  language plpgsql security definer set search_path = public
as $$
declare r text;
begin
  if new.email is null then return new; end if;
  select coalesce(default_new_role, 'pending') into r from public.settings where id = 1;
  insert into public.staff_permissions (email, permission)
    select lower(new.email), p from unnest(case r
      when 'approver' then array['edit', 'delete', 'send', 'approve']
      when 'photos'   then array['edit']
      when 'viewer'   then array['viewer']
      else array[]::text[] end) as p
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists auth_user_role on auth.users;
create trigger auth_user_role after insert on auth.users
  for each row execute function public.role_for_new_login();

-- Removing a login in Supabase also removes its permissions (an only admin is kept, so it can't lock everyone out)
create or replace function public.forget_removed_login() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if old.email is not null then
    delete from public.staff_permissions where email = lower(old.email) and permission <> 'admin';
    if exists (select 1 from public.staff_permissions where permission = 'admin' and email <> lower(old.email)) then
      delete from public.staff_permissions where email = lower(old.email);
    end if;
  end if;
  return old;
end $$;
drop trigger if exists auth_user_forget on auth.users;
create trigger auth_user_forget after delete on auth.users
  for each row execute function public.forget_removed_login();

-- ---------- People ----------
drop policy if exists "people read"   on public.people;
drop policy if exists "people add"    on public.people;
drop policy if exists "people edit"   on public.people;
drop policy if exists "people delete" on public.people;
create policy "people read"   on public.people for select to authenticated using (public.can_view_cards());
create policy "people add"    on public.people for insert to authenticated with check (public.has_perm('edit'));
create policy "people edit"   on public.people for update to authenticated using (public.has_perm('edit')) with check (public.has_perm('edit'));
create policy "people delete" on public.people for delete to authenticated using (public.has_perm('delete'));

-- ---------- Card settings ----------
drop policy if exists "settings read"   on public.settings;
drop policy if exists "settings change" on public.settings;
create policy "settings read"   on public.settings for select to authenticated using (public.can_view_cards() or public.has_perm('printer'));
create policy "settings change" on public.settings for all to authenticated using (public.has_perm('admin')) with check (public.has_perm('admin'));

-- ---------- Print jobs ----------
-- Sending: a job can only go straight to the printer if approval isn't needed, or the sender can approve
drop policy if exists "jobs read"   on public.print_jobs;
drop policy if exists "jobs send"   on public.print_jobs;
drop policy if exists "jobs update" on public.print_jobs;
drop policy if exists "jobs delete" on public.print_jobs;
create policy "jobs read"   on public.print_jobs for select to authenticated using (public.can_view_cards() or public.has_perm('printer'));
create policy "jobs send"   on public.print_jobs for insert to authenticated with check (public.has_perm('send') and (
  status = 'pending' or public.has_perm('approve')
  or not coalesce((select s.require_approval from public.settings s where s.id = 1), true)));
create policy "jobs update" on public.print_jobs for update to authenticated using (public.has_perm('approve', 'printer')) with check (public.has_perm('approve', 'printer'));
create policy "jobs delete" on public.print_jobs for delete to authenticated using (public.has_perm('admin'));

-- ---------- Print station status ----------
drop policy if exists "station read"   on public.print_station;
drop policy if exists "station report" on public.print_station;
create policy "station read"   on public.print_station for select to authenticated using (public.can_view_cards() or public.has_perm('printer'));
create policy "station report" on public.print_station for all to authenticated using (public.has_perm('printer')) with check (public.has_perm('printer'));

-- ---------- Files (photos, print files, signature) ----------
create or replace function public.can_write_card_file(path text) returns boolean
  language sql stable security definer set search_path = public, storage
as $$
  select case (storage.foldername(path))[1]
    when 'photos'   then public.has_perm('edit')
    when 'jobs'     then public.has_perm('send')
    when 'settings' then public.has_perm('admin')
    else false
  end
$$;
drop policy if exists "cards read" on storage.objects;
create policy "cards read" on storage.objects for select to authenticated
  using (bucket_id = 'cards' and (public.can_view_cards() or public.has_perm('printer')));

