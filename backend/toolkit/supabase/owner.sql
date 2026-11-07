-- AMA Toolkit: the owner's login (superadmin)
-- Run once in Supabase > SQL Editor. Safe to run again.
-- Owners are admins whose access nobody else can change: other admins can't remove their permissions in any app,
-- change their hub mobile, reset their password or delete their login. Only the owner can change their own login.
-- (The "staff" function checks the same list for passwords, set-up links, names and removing the login.)
-- To add or remove an owner, edit toolkit_owners here in the SQL Editor: there is no button for it on purpose.

create table if not exists public.toolkit_owners (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);
alter table public.toolkit_owners enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'toolkit_owners' and policyname = 'read') then
    create policy "read" on public.toolkit_owners for select to authenticated using (true);
  end if;
end $$;
revoke insert, update, delete on public.toolkit_owners from anon, authenticated;
grant select on public.toolkit_owners to authenticated;

insert into public.toolkit_owners (email) values ('theggatonklenner@gmail.com') on conflict do nothing;

-- Signed in as someone else: an owner's permission rows can't be changed or removed.
-- (Changes with no sign-in, like the SQL Editor or the staff function's own checks, go through.)
create or replace function public.toolkit_owner_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text := lower(nullif(auth.jwt() ->> 'email', ''));
        target text := lower(coalesce(case when tg_op = 'INSERT' then new.email else old.email end, ''));
begin
  if who is not null and who <> target and exists (select 1 from toolkit_owners where email = target) then
    raise exception 'This is the owner''s login. Only they can change its access.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

do $$ declare t text; begin
  foreach t in array array['prep_roles', 'staff_permissions', 'staff_roles', 'tv_permissions', 'hub_logins'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgname = 'toolkit_owner_guard' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger toolkit_owner_guard before insert or update or delete on public.%I for each row execute function public.toolkit_owner_guard()', t);
    end if;
  end loop;
end $$;
