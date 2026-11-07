-- AMA Toolkit: coloured belt grading (White to Red Three), at /grading/coloured-belts/
-- Run once in Supabase > SQL Editor, after Black Belt Prep's updates (it uses prep_roles and efc_members). Safe to run again.
--
-- EFC Aquila is the master for each student's belt, last grading date and classes since then (copied into efc_members).
-- This keeps what EFC doesn't: the classes each belt needs, instructor ready / not yet, grading days, invitations,
-- bookings, payments, results and the "promote in EFC" checklist. Results never change efc_members: staff promote in EFC.
--
-- Who can do what (Black Belt Prep roles, set on Staff logins; admins can do everything):
--   see everything                instructor, grading
--   ready / not yet               instructor, grading
--   grading days, invites, results grading
--   paid                          grading, payments
--   belts and settings            admin

-- Belts in EFC's order, the classes each needs before grading, and the fee shown to families
create table if not exists public.cb_belts (
  belt           text primary key,              -- EFC's grade name, e.g. "Yellow Belt"
  sort           int not null unique,
  next_belt      text not null,                 -- what they grade to
  classes_needed int not null default 24 check (classes_needed between 0 and 500),
  weeks_between  int not null default 13 check (weeks_between between 0 and 104),   -- usual time at this belt before grading (about 3 months)
  fee            numeric(8,2),                  -- shown in invitations; EFC charges it through the grading session
  colour         text,                          -- for the app (hex)
  updated_at     timestamptz not null default now()
);
insert into public.cb_belts (belt, sort, next_belt, colour) values
  ('White Belt', 1, 'Yellow Belt', '#e8e8e8'), ('Yellow Belt', 2, 'Orange Belt', '#e5c700'), ('Orange Belt', 3, 'Green Belt', '#e8822a'),
  ('Green Belt', 4, 'Blue Belt', '#2e8b57'), ('Blue Belt', 5, 'Purple Belt', '#2f5fa8'), ('Purple Belt', 6, 'Brown Belt', '#7b4fa8'),
  ('Brown Belt', 7, 'Red Belt', '#7a5230'), ('Red Belt', 8, 'Red Two Belt', '#c0392b'), ('Red Two Belt', 9, 'Red Three Belt', '#c0392b'),
  ('Red Three Belt', 10, 'Cho Dan Bo', '#c0392b')
on conflict (belt) do nothing;

alter table public.cb_belts add column if not exists weeks_between int not null default 13;

-- One row of settings
create table if not exists public.cb_settings (
  id                 int primary key default 1 check (id = 1),
  booking_webhook    text,                        -- Zapier "Catch Hook" that books an EFC session (member_id, date, session, location)
  invite_text        text not null default 'Hi {parent}, {first} is invited to grade for their {next} at AMA {school} on {date}{time}. Book their spot here: {link}',
  congrats_text      text not null default 'Congratulations {first}! {first} passed their grading{distinction} and is now a {next}. Thank you for your support. AMA {school}',
  not_ready_text     text not null default 'Hi {parent}, {first} is working hard but isn''t quite ready to grade this time. {note} We''ll keep helping them get there for the next grading. AMA {school}',
  updated_at         timestamptz not null default now()
);
-- More texts: a reminder before the day, a nudge for invited families who haven't booked, unpaid fees, and re-tests
alter table public.cb_settings add column if not exists reminder_text text not null default 'Hi {parent}, a reminder that {first}''s grading for their {next} is on {date}{time} at AMA {school}. Please arrive 15 minutes early in a clean uniform. See you there!';
alter table public.cb_settings add column if not exists not_booked_text text not null default 'Hi {parent}, {first} is invited to grade for their {next} on {date}{time} at AMA {school}, but we don''t have a booking yet. Book their spot here: {link}';
alter table public.cb_settings add column if not exists unpaid_text text not null default 'Hi {parent}, thanks for booking {first}''s grading on {date}. The grading fee is still to be paid in your EFC account. Please contact the front desk if you have any questions. AMA {school}';
alter table public.cb_settings add column if not exists retest_text text not null default 'Hi {parent}, {first} worked hard at their grading today. They need a little more practice before their {next}, so they''ll re-test soon. We''re proud of their effort. AMA {school}';
insert into public.cb_settings (id) values (1) on conflict (id) do nothing;

-- Grading days, per school, each linked to its EFC grading session (booking it is how the fee is charged)
create table if not exists public.cb_days (
  day_id         uuid primary key default gen_random_uuid(),
  location       text not null check (location in ('Marrickville', 'Sydenham', 'Concord', 'West', 'Sylvania')),
  grading_date   date not null,
  start_time     time,
  efc_session_id text,                          -- the EFC session families are booked into
  efc_session    text,                          -- its name, for showing
  notes          text,
  belts          text[],                        -- the belts this day is for (their current belt); empty = every belt
  closed         boolean not null default false, -- finished: results in
  created_by     text default public.prep_email(),
  created_at     timestamptz not null default now()
);
create index if not exists cb_days_date_idx on public.cb_days (grading_date);
alter table public.cb_days add column if not exists belts text[];

-- Instructor's ready / not yet, for the belt the student is on now (a new belt in EFC starts fresh)
create table if not exists public.cb_approvals (
  member_key  text primary key,                 -- efc_members.member_key
  belt        text not null,                    -- the belt it was decided for
  status      text not null check (status in ('ready', 'not_yet')),
  note        text,                             -- what to work on (used in the "not yet" message)
  decided_by  text default public.prep_email(),
  decided_at  timestamptz not null default now()
);

-- A student on a grading day: invited, booked, paid, result, promoted in EFC
create table if not exists public.cb_entries (
  entry_id        uuid primary key default gen_random_uuid(),
  day_id          uuid not null references public.cb_days on delete cascade,
  member_key      text not null,
  full_name       text not null,                -- copied, so a day keeps its list even if EFC changes
  belt_from       text not null,
  belt_to         text not null,
  token           text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),   -- the family's booking link
  invited_at      timestamptz,
  booked_at       timestamptz,
  booking_error   text,
  paid            boolean not null default false,
  paid_at         timestamptz,
  result          text check (result in ('pass', 'distinction', 'retest')),
  result_at       timestamptz,
  result_by       text,
  efc_done        boolean not null default false,   -- promoted in EFC
  efc_done_at     timestamptz,
  efc_done_by     text,
  created_at      timestamptz not null default now(),
  unique (day_id, member_key)
);
create index if not exists cb_entries_member_idx on public.cb_entries (member_key);

-- Every text sent
create table if not exists public.cb_messages (
  message_id  uuid primary key default gen_random_uuid(),
  entry_id    uuid references public.cb_entries on delete set null,
  member_key  text,
  kind        text not null,
  phone       text,
  body        text,
  status      text not null,                     -- sent, failed, test
  error       text,
  sent_by     text,
  sent_at     timestamptz not null default now()
);

alter table public.cb_messages drop constraint if exists cb_messages_kind_check;
alter table public.cb_messages add constraint cb_messages_kind_check check (kind in ('invite', 'not_booked', 'reminder', 'unpaid', 'congrats', 'retest', 'not_ready'));

-- Students on a coloured belt at the five schools, from EFC, with what this app adds
create or replace view public.cb_students with (security_invoker = true) as
select m.member_key, m.full_name, m.guardian_name, coalesce(m.phone, m.guardian_phone) as phone, coalesce(m.email, m.guardian_email) as email,
       m.efc_reference, replace(m.member_key, 'efc:', '') as efc_id, m.location, m.belt, b.next_belt, b.sort as belt_sort, b.colour,
       m.promoted_on, (current_date - m.promoted_on) / 7 as weeks_at_belt,
       coalesce(m.attended_since_promoted, 0) as classes, b.classes_needed,
       coalesce(m.attended_since_promoted, 0) >= b.classes_needed as enough_classes,
       b.weeks_between, (current_date - m.promoted_on) / 7 >= b.weeks_between as enough_time,
       case when a.belt = m.belt then a.status end as approval, case when a.belt = m.belt then a.note end as approval_note,
       case when a.belt = m.belt then a.decided_by end as decided_by,
       m.updated_at as efc_updated_at
  from public.efc_members m
  join public.cb_belts b on b.belt = m.belt
  left join public.cb_approvals a on a.member_key = m.member_key
 where m.kind = 'member' and m.programme = 'Taekwondo'
   and m.location in ('Marrickville', 'Sydenham', 'Concord', 'West', 'Sylvania');

-- Security
alter table public.cb_belts enable row level security;
alter table public.cb_settings enable row level security;
alter table public.cb_days enable row level security;
alter table public.cb_approvals enable row level security;
alter table public.cb_entries enable row level security;
alter table public.cb_messages enable row level security;
do $$ declare t text; begin
  foreach t in array array['cb_belts', 'cb_settings', 'cb_days', 'cb_approvals', 'cb_entries', 'cb_messages'] loop
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (public.prep_has_role(''instructor'', ''grading'', ''payments''))', t);
  end loop;
end $$;
drop policy if exists "write" on public.cb_belts;
create policy "write" on public.cb_belts for all to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
drop policy if exists "write" on public.cb_settings;
create policy "write" on public.cb_settings for all to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
drop policy if exists "write" on public.cb_days;
create policy "write" on public.cb_days for all to authenticated using (public.prep_has_role('grading')) with check (public.prep_has_role('grading'));
drop policy if exists "write" on public.cb_approvals;
create policy "write" on public.cb_approvals for all to authenticated using (public.prep_has_role('instructor', 'grading')) with check (public.prep_has_role('instructor', 'grading'));
drop policy if exists "write" on public.cb_entries;
create policy "write" on public.cb_entries for all to authenticated using (public.prep_has_role('grading')) with check (public.prep_has_role('grading'));
-- Payments staff can tick paid (and nothing else on an entry)
create or replace function public.cb_set_paid(p_entry uuid, p_paid boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('grading', 'payments') then raise exception 'Only grading or payments staff can change paid.'; end if;
  update cb_entries set paid = p_paid, paid_at = case when p_paid then now() end where entry_id = p_entry;
end $$;
revoke all on function public.cb_set_paid(uuid, boolean) from public, anon;
grant execute on function public.cb_set_paid(uuid, boolean) to authenticated;
-- Messages are written by the "cb" function only
revoke insert, update, delete on public.cb_messages from authenticated;
revoke all on public.cb_belts, public.cb_settings, public.cb_days, public.cb_approvals, public.cb_entries, public.cb_messages, public.cb_students from anon;
grant select on public.cb_students to authenticated;
