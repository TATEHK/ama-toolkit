-- AMA ID Cards: user roles
-- Run once in Supabase > SQL Editor (after setup.sql). Safe to run again.
--
--   admin     everything, including card settings, backups and managing users
--   approver  add, edit and delete people, take photos, send and approve prints
--   photos    add people, edit their details and take photos (no printing or deleting)
--   viewer    can look but not change anything
--   printer   the laptop's print station account (prints jobs, reports its status)
--   pending   has a login but no access yet (shown as "No access" in the app)
--
-- Logins created in Supabase (Authentication > Users) are picked up automatically and get the
-- role chosen in the app under More > Users > "New logins from Supabase" (No access by default).
--
-- Everyone who can already sign in starts as an admin. Change roles in the app: More > Users.

create table if not exists public.staff_roles (
  email      text primary key,
  role       text not null,
  created_at timestamptz not null default now()
);
alter table public.staff_roles drop constraint if exists staff_roles_role_check;
alter table public.staff_roles add constraint staff_roles_role_check
  check (role in ('admin', 'approver', 'photos', 'viewer', 'printer', 'pending'));
insert into public.staff_roles (email, role)
  select lower(email), 'admin' from auth.users where email is not null
  on conflict (email) do nothing;

create or replace function public.my_role() returns text
  language sql stable security definer set search_path = public
  as $$ select role from public.staff_roles where email = lower(auth.jwt() ->> 'email') $$;

create or replace function public.has_role(variadic roles text[]) returns boolean
  language sql stable security definer set search_path = public
  as $$ select coalesce((select role from public.staff_roles where email = lower(auth.jwt() ->> 'email')) = any(roles), false) $$;

grant execute on function public.my_role() to authenticated;
grant execute on function public.has_role(text[]) to authenticated;

-- Logins created directly in Supabase get a role automatically
alter table public.settings add column if not exists default_new_role text not null default 'pending';
create or replace function public.role_for_new_login() returns trigger
  language plpgsql security definer set search_path = public
as $$
declare r text;
begin
  if new.email is null then return new; end if;
  select coalesce(default_new_role, 'pending') into r from public.settings where id = 1;
  if r is null or r not in ('approver', 'photos', 'viewer', 'pending') then r := 'pending'; end if;
  insert into public.staff_roles (email, role) values (lower(new.email), r) on conflict (email) do nothing;
  return new;
end $$;
drop trigger if exists auth_user_role on auth.users;
create trigger auth_user_role after insert on auth.users
  for each row execute function public.role_for_new_login();

-- Removing a login in Supabase also removes it from the app's user list
create or replace function public.forget_removed_login() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if old.email is not null then
    delete from public.staff_roles where email = lower(old.email) and role <> 'admin';
  end if;
  return old;
end $$;
drop trigger if exists auth_user_forget on auth.users;
create trigger auth_user_forget after delete on auth.users
  for each row execute function public.forget_removed_login();

-- Who can see and change roles
alter table public.staff_roles enable row level security;
drop policy if exists "see own role or all as admin" on public.staff_roles;
drop policy if exists "admins manage roles" on public.staff_roles;
create policy "see own role or all as admin" on public.staff_roles for select to authenticated
  using (email = lower(auth.jwt() ->> 'email') or public.has_role('admin'));
create policy "admins manage roles" on public.staff_roles for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Never leave the system without an admin
create or replace function public.keep_an_admin() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    if not exists (select 1 from public.staff_roles where role = 'admin' and email <> old.email) then
      raise exception 'There must always be at least one admin.';
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists staff_roles_keep_admin on public.staff_roles;
create trigger staff_roles_keep_admin before update or delete on public.staff_roles
  for each row execute function public.keep_an_admin();

-- ---------- People ----------
drop policy if exists "staff full access" on public.people;
drop policy if exists "people read" on public.people;
drop policy if exists "people add" on public.people;
drop policy if exists "people edit" on public.people;
drop policy if exists "people delete" on public.people;
create policy "people read"   on public.people for select to authenticated using (public.has_role('admin', 'approver', 'photos', 'viewer'));
create policy "people add"    on public.people for insert to authenticated with check (public.has_role('admin', 'approver', 'photos'));
create policy "people edit"   on public.people for update to authenticated using (public.has_role('admin', 'approver', 'photos')) with check (public.has_role('admin', 'approver', 'photos'));
create policy "people delete" on public.people for delete to authenticated using (public.has_role('admin', 'approver'));

-- ---------- Card settings ----------
drop policy if exists "staff full access" on public.settings;
drop policy if exists "settings read" on public.settings;
drop policy if exists "settings change" on public.settings;
create policy "settings read"   on public.settings for select to authenticated using (public.has_role('admin', 'approver', 'photos', 'viewer', 'printer'));
create policy "settings change" on public.settings for all to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

-- ---------- Print jobs ----------
drop policy if exists "staff full access" on public.print_jobs;
drop policy if exists "jobs read" on public.print_jobs;
drop policy if exists "jobs send" on public.print_jobs;
drop policy if exists "jobs update" on public.print_jobs;
drop policy if exists "jobs delete" on public.print_jobs;
create policy "jobs read"   on public.print_jobs for select to authenticated using (public.has_role('admin', 'approver', 'photos', 'viewer', 'printer'));
create policy "jobs send"   on public.print_jobs for insert to authenticated with check (public.has_role('admin', 'approver'));
create policy "jobs update" on public.print_jobs for update to authenticated using (public.has_role('admin', 'approver', 'printer')) with check (public.has_role('admin', 'approver', 'printer'));
create policy "jobs delete" on public.print_jobs for delete to authenticated using (public.has_role('admin'));

-- ---------- Print station status ----------
drop policy if exists "staff full access" on public.print_station;
drop policy if exists "station read" on public.print_station;
drop policy if exists "station report" on public.print_station;
create policy "station read"   on public.print_station for select to authenticated using (public.has_role('admin', 'approver', 'photos', 'viewer', 'printer'));
create policy "station report" on public.print_station for all to authenticated using (public.has_role('admin', 'printer')) with check (public.has_role('admin', 'printer'));

-- ---------- Files (photos, print files, signature) ----------
drop policy if exists "cards staff read"   on storage.objects;
drop policy if exists "cards staff insert" on storage.objects;
drop policy if exists "cards staff update" on storage.objects;
drop policy if exists "cards staff delete" on storage.objects;
drop policy if exists "cards read"   on storage.objects;
drop policy if exists "cards write"  on storage.objects;
drop policy if exists "cards change" on storage.objects;
drop policy if exists "cards remove" on storage.objects;

create or replace function public.can_write_card_file(path text) returns boolean
  language sql stable security definer set search_path = public, storage
as $$
  select case (storage.foldername(path))[1]
    when 'photos'   then public.has_role('admin', 'approver', 'photos')
    when 'jobs'     then public.has_role('admin', 'approver')
    when 'settings' then public.has_role('admin')
    else false
  end
$$;
grant execute on function public.can_write_card_file(text) to authenticated;

create policy "cards read"   on storage.objects for select to authenticated
  using (bucket_id = 'cards' and public.has_role('admin', 'approver', 'photos', 'viewer', 'printer'));
create policy "cards write"  on storage.objects for insert to authenticated
  with check (bucket_id = 'cards' and public.can_write_card_file(name));
create policy "cards change" on storage.objects for update to authenticated
  using (bucket_id = 'cards' and public.can_write_card_file(name));
create policy "cards remove" on storage.objects for delete to authenticated
  using (bucket_id = 'cards' and public.can_write_card_file(name));
