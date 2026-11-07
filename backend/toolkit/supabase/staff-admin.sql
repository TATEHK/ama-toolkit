-- AMA Toolkit: permission rework — Phase 1 (foundation).
-- Run once in Supabase > SQL Editor. Safe to run again. ADDITIVE ONLY: nobody loses access when this runs.
--
-- Adds two things:
--   1. staff_admins  — a dedicated "can manage staff logins" permission, separate from being an app admin.
--      Seeded with everyone who is CURRENTLY a full admin (admin in both AMA ID Cards and Black Belt Gradings)
--      plus the owner(s), so the cutover changes nothing until you narrow the list on the Staff logins page.
--   2. toolkit_audit — an append-only log of every staff-login change (who did what, to whom, when).
--
-- The "staff" edge function is updated separately to (a) require staff_admins (or owner) instead of
-- "admin in both apps", and (b) write a toolkit_audit row on every change. Deploy that AFTER this runs.

-- 1. Who may manage staff logins ------------------------------------------------------------------
create table if not exists public.staff_admins (
  email      text primary key check (email = lower(email)),
  added_by   text,
  added_at   timestamptz not null default now()
);
alter table public.staff_admins enable row level security;
revoke all on public.staff_admins from anon, authenticated;
grant select on public.staff_admins to authenticated;     -- so the UI can show who's a staff admin
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='staff_admins' and policyname='read') then
    create policy "read" on public.staff_admins for select to authenticated using (true);
  end if;
end $$;

-- Seed: current full admins (admin in BOTH apps) + owners, so no one is locked out on cutover.
insert into public.staff_admins (email, added_by)
select e, 'migration' from (
  select email from public.staff_permissions where permission = 'admin'
  intersect
  select email from public.prep_roles where role = 'admin'
  union
  select email from public.toolkit_owners
) s(e)
on conflict (email) do nothing;

-- Helper the edge function (and RLS, later phases) can use.
create or replace function public.is_staff_admin(p_email text default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff_admins
     where email = lower(coalesce(p_email, auth.jwt() ->> 'email'))
  ) or exists (
    select 1 from public.toolkit_owners
     where email = lower(coalesce(p_email, auth.jwt() ->> 'email'))
  );
$$;
revoke all on function public.is_staff_admin(text) from anon;
grant execute on function public.is_staff_admin(text) to authenticated;

-- 2. Audit log ------------------------------------------------------------------------------------
create table if not exists public.toolkit_audit (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_email  text,
  action       text not null,        -- create | roles | password | link | details | hub | remove | bulk | staff_admin
  target_email text,
  detail       jsonb not null default '{}'::jsonb
);
create index if not exists toolkit_audit_at_idx on public.toolkit_audit (at desc);
create index if not exists toolkit_audit_target_idx on public.toolkit_audit (target_email);
alter table public.toolkit_audit enable row level security;
revoke all on public.toolkit_audit from anon, authenticated;
-- Staff admins may read the log; only the service-role "staff" function writes to it.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='toolkit_audit' and policyname='read') then
    create policy "read" on public.toolkit_audit for select to authenticated using (public.is_staff_admin());
  end if;
end $$;
grant select on public.toolkit_audit to authenticated;

-- 3. Protect the new permission the same way owners are protected --------------------------------
-- (nobody can hand themselves staff-admin by editing rows directly if they aren't already; owner rows locked)
do $$ begin
  if to_regclass('public.staff_admins') is not null
     and not exists (select 1 from pg_trigger where tgname = 'toolkit_owner_guard' and tgrelid = 'public.staff_admins'::regclass) then
    create trigger toolkit_owner_guard before insert or update or delete on public.staff_admins
      for each row execute function public.toolkit_owner_guard();
  end if;
end $$;
