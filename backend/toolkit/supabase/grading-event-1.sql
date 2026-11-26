-- grading-event-1: run a whole grading day from the Toolkit (site/grading/event/), first used for the
-- Beyond 4th Dan grading on Sat 28 Nov 2026. One event = one config (candidates, groups, run-of-day blocks,
-- scoring items, live quiz, public-hour running order). Staff = Black Belt Gradings logins (app_permissions 'bb').
--   ge_events    the event, its config and live state (current block/step, timers, MC position)
--   ge_present   roll call
--   ge_marks     pass/fail + comment per candidate per item code
--   ge_outcomes  the overall result per candidate (held until an admin approves the event's results)
--   ge_quiz / ge_players / ge_answers   the live quiz; written only by the "gevent" function (server timing + points)

create table if not exists public.ge_events (
  event_id      uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  title         text not null,
  day_id        uuid references public.cb_days(day_id) on delete set null,
  starts_at     timestamptz,
  config        jsonb not null default '{}'::jsonb,
  live          jsonb not null default '{}'::jsonb,
  join_code     text not null unique,
  approved_at   timestamptz,
  approved_by   text,
  recorded_at   timestamptz,      -- results written to the grading list (cb_entries.result)
  recorded_by   text,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create table if not exists public.ge_present (
  event_id uuid not null references public.ge_events(event_id) on delete cascade,
  cand_id  text not null,
  at       timestamptz not null default now(),
  by       text,
  primary key (event_id, cand_id)
);

create table if not exists public.ge_marks (
  event_id  uuid not null references public.ge_events(event_id) on delete cascade,
  cand_id   text not null,
  item_code text not null,
  result    text check (result in ('pass', 'fail')),
  comment   text,
  scored_by text,
  updated_at timestamptz not null default now(),
  primary key (event_id, cand_id, item_code)
);

create table if not exists public.ge_outcomes (
  event_id uuid not null references public.ge_events(event_id) on delete cascade,
  cand_id  text not null,
  outcome  text not null check (outcome in ('pass', 'fail', 'retest')),
  note     text,
  set_by   text,
  set_at   timestamptz not null default now(),
  primary key (event_id, cand_id)
);

create table if not exists public.ge_quiz (
  event_id     uuid primary key references public.ge_events(event_id) on delete cascade,
  phase        text not null default 'closed' check (phase in ('closed', 'lobby', 'question', 'reveal', 'leaderboard', 'podium')),
  q_ix         integer not null default -1,
  q_started_at timestamptz,
  q_ends_at    timestamptz,
  updated_at   timestamptz not null default now()
);

create table if not exists public.ge_players (
  event_id   uuid not null references public.ge_events(event_id) on delete cascade,
  cand_id    text not null,
  token_hash text not null,
  via        text not null default 'phone',
  joined_at  timestamptz not null default now(),
  primary key (event_id, cand_id)
);

create table if not exists public.ge_answers (
  event_id    uuid not null references public.ge_events(event_id) on delete cascade,
  cand_id     text not null,
  q_ix        integer not null,
  answer      jsonb,
  ms          integer,
  correct     boolean not null default false,
  points      integer not null default 0,
  streak      integer not null default 0,
  answered_at timestamptz not null default now(),
  primary key (event_id, cand_id, q_ix)
);

-- Who can do what (Black Belt Gradings permissions; admin can do everything)
create or replace function public.ge_can(variadic perms text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_permissions p
                 where p.email = lower(auth.jwt() ->> 'email') and p.app = 'bb'
                   and (p.perm = any(perms) or p.perm = 'admin'))
$$;
create or replace function public.ge_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_permissions p where p.email = lower(auth.jwt() ->> 'email') and p.app = 'bb')
$$;

alter table public.ge_events   enable row level security;
alter table public.ge_present  enable row level security;
alter table public.ge_marks    enable row level security;
alter table public.ge_outcomes enable row level security;
alter table public.ge_quiz     enable row level security;
alter table public.ge_players  enable row level security;
alter table public.ge_answers  enable row level security;
revoke all on public.ge_events, public.ge_present, public.ge_marks, public.ge_outcomes, public.ge_quiz, public.ge_players, public.ge_answers from anon;

drop policy if exists "ge staff read" on public.ge_events;   create policy "ge staff read" on public.ge_events   for select to authenticated using (public.ge_staff());
drop policy if exists "ge staff read" on public.ge_present;  create policy "ge staff read" on public.ge_present  for select to authenticated using (public.ge_staff());
drop policy if exists "ge staff read" on public.ge_marks;    create policy "ge staff read" on public.ge_marks    for select to authenticated using (public.ge_staff());
drop policy if exists "ge staff read" on public.ge_outcomes; create policy "ge staff read" on public.ge_outcomes for select to authenticated using (public.ge_staff());
drop policy if exists "ge staff read" on public.ge_quiz;     create policy "ge staff read" on public.ge_quiz     for select to authenticated using (public.ge_staff());
drop policy if exists "ge staff read" on public.ge_players;  create policy "ge staff read" on public.ge_players  for select to authenticated using (public.ge_staff());
drop policy if exists "ge staff read" on public.ge_answers;  create policy "ge staff read" on public.ge_answers  for select to authenticated using (public.ge_staff());

-- Roll call: attendance, grading or scoring staff
drop policy if exists "ge roll call" on public.ge_present;
create policy "ge roll call" on public.ge_present for all to authenticated
  using (public.ge_can('attendance', 'grading', 'scoring')) with check (public.ge_can('attendance', 'grading', 'scoring'));

-- Marks: scoring, grading or results staff, and only until the results are approved
drop policy if exists "ge marks write" on public.ge_marks;
create policy "ge marks write" on public.ge_marks for all to authenticated
  using (public.ge_can('scoring', 'grading', 'results') and not exists (select 1 from public.ge_events e where e.event_id = ge_marks.event_id and e.approved_at is not null))
  with check (public.ge_can('scoring', 'grading', 'results') and not exists (select 1 from public.ge_events e where e.event_id = ge_marks.event_id and e.approved_at is not null));

-- Overall results: grading or results staff, until approved
drop policy if exists "ge outcomes write" on public.ge_outcomes;
create policy "ge outcomes write" on public.ge_outcomes for all to authenticated
  using (public.ge_can('grading', 'results') and not exists (select 1 from public.ge_events e where e.event_id = ge_outcomes.event_id and e.approved_at is not null))
  with check (public.ge_can('grading', 'results') and not exists (select 1 from public.ge_events e where e.event_id = ge_outcomes.event_id and e.approved_at is not null));

-- Live state (current block/step, timers, MC position): merged so two screens never wipe each other's keys
create or replace function public.ge_live_set(p_event uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.ge_can('grading', 'scoring', 'attendance') then raise exception 'Not allowed'; end if;
  update public.ge_events set live = live || coalesce(p_patch, '{}'::jsonb), updated_at = now() where event_id = p_event returning live into v;
  return v;
end $$;
revoke all on function public.ge_live_set(uuid, jsonb) from public, anon;
grant execute on function public.ge_live_set(uuid, jsonb) to authenticated;

-- Approve the results (admins only). Locks marks and outcomes.
create or replace function public.ge_approve(p_event uuid, p_on boolean) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v timestamptz;
begin
  if not public.ge_can('admin') then raise exception 'Only an admin can approve results'; end if;
  update public.ge_events set approved_at = case when p_on then now() else null end,
         approved_by = case when p_on then lower(auth.jwt() ->> 'email') else null end, updated_at = now()
   where event_id = p_event and (p_on or recorded_at is null) returning approved_at into v;
  return v;
end $$;
revoke all on function public.ge_approve(uuid, boolean) from public, anon;
grant execute on function public.ge_approve(uuid, boolean) to authenticated;

-- Event config edits (e.g. showcase acts and their performers) by grading staff
create or replace function public.ge_config_set(p_event uuid, p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.ge_can('grading') then raise exception 'Not allowed'; end if;
  if p_key not in ('acts', 'groups_note') then raise exception 'That setting can''t be changed here'; end if;
  update public.ge_events set config = jsonb_set(config, array[p_key], p_value, true), updated_at = now() where event_id = p_event;
end $$;
revoke all on function public.ge_config_set(uuid, text, jsonb) from public, anon;
grant execute on function public.ge_config_set(uuid, text, jsonb) to authenticated;
