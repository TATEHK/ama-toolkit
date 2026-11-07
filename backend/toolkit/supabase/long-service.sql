-- AMA Toolkit: long service awards (every 5 years a member is with AMA)
-- Run once in Supabase > SQL Editor, after coloured-belts.sql (it uses prep_has_role). Safe to run again.
--
-- EFC doesn't send anyone's enrolled date, but its Member Query can ask "enrolled between X and Y weeks ago". The weekly
-- scheduled task asks in month-sized bands around this year's award window and saves, for each member it finds, the range
-- their enrolled date falls in (enrolled_from .. enrolled_to). The page works out each person's 5, 10, 15... year date from it.
-- Only names, school and that date range are kept: no contacts, balances or medical details.

create table if not exists public.lsa_members (
  member_key    text primary key,                 -- 'efc:<EFC member id>', or 'manual:<uuid>' for someone added by hand
  full_name     text not null,
  location      text,
  efc_reference text,
  enrolled_from date,                             -- EFC's enrolled date is on or after this...
  enrolled_to   date,                             -- ...and on or before this
  seen_at       timestamptz,                      -- last time the weekly EFC check found them enrolled
  start_override date,                            -- staff: count from this date instead (e.g. joined before EFC)
  break_months  int not null default 0 check (break_months between 0 and 600),   -- staff: time away, taken off
  note          text,
  added_by      text,
  updated_at    timestamptz not null default now(),
  updated_by    text
);

create table if not exists public.lsa_awards (
  member_key text not null references public.lsa_members (member_key) on delete cascade,
  years      int  not null check (years > 0 and years % 5 = 0),
  status     text not null check (status in ('ordered', 'given', 'skip')),
  note       text,
  done_at    timestamptz not null default now(),
  done_by    text,
  primary key (member_key, years)
);

create table if not exists public.lsa_settings (
  id            int primary key default 1 check (id = 1),
  leeway_months int not null default 2 check (leeway_months between 0 and 6),
  updated_at    timestamptz not null default now()
);
insert into public.lsa_settings (id) values (1) on conflict (id) do nothing;

-- Moving an award to a different December (e.g. reached it in January, but given at this December's awards):
-- round = which December it counts for (blank = worked out from the date). 'due' = moved, not ordered yet.
alter table public.lsa_awards add column if not exists round int check (round between 2000 and 2100);
alter table public.lsa_awards drop constraint if exists lsa_awards_status_check;
alter table public.lsa_awards add constraint lsa_awards_status_check check (status in ('due', 'ordered', 'given', 'skip'));

-- Double check flag: staff (or a one-off check) mark someone to look at before ordering, e.g. not enrolled in EFC.
-- The text says why; clearing it (null) means it's been checked.
alter table public.lsa_members add column if not exists check_flag text;

-- Weekly check results, so the page can say when EFC was last checked
create table if not exists public.lsa_runs (
  id      bigint generated always as identity primary key,
  ran_at  timestamptz not null default now(),
  found   int not null default 0,
  added   int not null default 0
);

alter table public.lsa_members  enable row level security;
alter table public.lsa_awards   enable row level security;
alter table public.lsa_settings enable row level security;
alter table public.lsa_runs     enable row level security;

drop policy if exists "read" on public.lsa_members;
drop policy if exists "read" on public.lsa_awards;
drop policy if exists "read" on public.lsa_settings;
drop policy if exists "read" on public.lsa_runs;
create policy "read" on public.lsa_members  for select to authenticated using (public.prep_has_role('instructor', 'grading', 'payments'));
create policy "read" on public.lsa_awards   for select to authenticated using (public.prep_has_role('instructor', 'grading', 'payments'));
create policy "read" on public.lsa_settings for select to authenticated using (public.prep_has_role('instructor', 'grading', 'payments'));
create policy "read" on public.lsa_runs     for select to authenticated using (public.prep_has_role('instructor', 'grading', 'payments'));

-- Staff with instructor or grading can mark awards, add people by hand and change a person's start or break
drop policy if exists "write" on public.lsa_awards;
create policy "write" on public.lsa_awards for all to authenticated
  using (public.prep_has_role('instructor', 'grading')) with check (public.prep_has_role('instructor', 'grading'));
drop policy if exists "add" on public.lsa_members;
create policy "add" on public.lsa_members for insert to authenticated
  with check (public.prep_has_role('instructor', 'grading') and member_key like 'manual:%');
drop policy if exists "change" on public.lsa_members;
create policy "change" on public.lsa_members for update to authenticated
  using (public.prep_has_role('instructor', 'grading')) with check (public.prep_has_role('instructor', 'grading'));
drop policy if exists "remove" on public.lsa_members;
create policy "remove" on public.lsa_members for delete to authenticated
  using (public.prep_has_role('instructor', 'grading') and member_key like 'manual:%');
drop policy if exists "write" on public.lsa_settings;
create policy "write" on public.lsa_settings for update to authenticated
  using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));

-- Who changed what
create or replace function public.lsa_awards_stamp() returns trigger language plpgsql set search_path = public as $$
begin
  new.done_by := coalesce(public.prep_email(), new.done_by); new.done_at := now();
  return new;
end $$;
create or replace function public.lsa_members_stamp() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if public.prep_email() is not null then
    new.updated_by := public.prep_email();
    if tg_op = 'INSERT' then new.added_by := public.prep_email(); end if;
  end if;
  return new;
end $$;
create or replace function public.lsa_settings_stamp() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
drop function if exists public.lsa_stamp() cascade;
drop trigger if exists lsa_awards_stamp on public.lsa_awards;
create trigger lsa_awards_stamp before insert or update on public.lsa_awards for each row execute function public.lsa_awards_stamp();
drop trigger if exists lsa_members_stamp on public.lsa_members;
create trigger lsa_members_stamp before insert or update on public.lsa_members for each row execute function public.lsa_members_stamp();
drop trigger if exists lsa_settings_stamp on public.lsa_settings;
create trigger lsa_settings_stamp before update on public.lsa_settings for each row execute function public.lsa_settings_stamp();

-- Staff can only change a person's start date, break and note (not what EFC said)
create or replace function public.lsa_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if public.prep_email() is null then return new; end if;   -- the weekly check (no login)
  if new.member_key not like 'manual:%' then
    new.full_name := old.full_name; new.location := old.location; new.efc_reference := old.efc_reference;
    new.enrolled_from := old.enrolled_from; new.enrolled_to := old.enrolled_to; new.seen_at := old.seen_at;
  end if;
  new.member_key := old.member_key;
  return new;
end $$;
drop trigger if exists lsa_members_guard on public.lsa_members;
create trigger lsa_members_guard before update on public.lsa_members for each row execute function public.lsa_guard();

-- The weekly check: p is [{"id": EFC id, "ref": reference, "name": full name, "loc": school, "from": date, "to": date}, ...]
-- New people are added; known people get their name, school and (narrowed) date range updated and are marked as seen.
create or replace function public.lsa_load(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0; added int := 0; f date; t date; k text;
begin
  for r in select * from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    k := 'efc:' || (r ->> 'id'); f := (r ->> 'from')::date; t := (r ->> 'to')::date;
    if r ->> 'id' is null or coalesce(trim(r ->> 'name'), '') = '' then continue; end if;
    n := n + 1;
    if not exists (select 1 from lsa_members where member_key = k) then added := added + 1; end if;
    insert into lsa_members as m (member_key, full_name, location, efc_reference, enrolled_from, enrolled_to, seen_at)
      values (k, trim(r ->> 'name'), r ->> 'loc', r ->> 'ref', f, t, now())
    on conflict (member_key) do update set
      full_name = excluded.full_name, location = coalesce(excluded.location, m.location), efc_reference = coalesce(excluded.efc_reference, m.efc_reference),
      -- EFC's date can change (e.g. re-enrolled): if the new range doesn't overlap the old one, take the new one
      enrolled_from = case when m.enrolled_from is null or excluded.enrolled_from > m.enrolled_to or excluded.enrolled_to < m.enrolled_from then excluded.enrolled_from
                           else greatest(m.enrolled_from, excluded.enrolled_from) end,
      enrolled_to   = case when m.enrolled_to is null or excluded.enrolled_from > m.enrolled_to or excluded.enrolled_to < m.enrolled_from then excluded.enrolled_to
                           else least(m.enrolled_to, excluded.enrolled_to) end,
      seen_at = now();
  end loop;
  insert into lsa_runs (found, added) values (n, added);
  return jsonb_build_object('found', n, 'added', added);
end $$;
revoke all on function public.lsa_load(jsonb) from public, anon, authenticated;

grant select, insert, update, delete on public.lsa_members, public.lsa_awards to authenticated;
grant select, update on public.lsa_settings to authenticated;
grant select on public.lsa_runs to authenticated;
