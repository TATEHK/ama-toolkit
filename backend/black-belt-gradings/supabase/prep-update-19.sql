-- Black Belt Prep: update 19 — grading enrolment "nurture" sequence (editable from the app, nothing hard-coded)
-- Run once in Supabase > SQL Editor. Safe to run again.
--
-- A 12-day sequence that nudges invited black belt candidates to enrol and pay before the final prep session,
-- then switches to "booked in" reminders once they pay. Every message, date and time lives in a table an admin
-- edits in Settings — this file only seeds sensible defaults. Nothing sends on its own: an admin presses Start
-- for a cycle, and a scheduled function (update 20) does the sending, checking the grading fee before every send.
--
-- Fields in message bodies (same style as prep_message_templates): {first_name} {name} {belt} {current_belt}
-- {grading_date} {link} {prep_time}. Subjects are for email only. essay_only rows show only when the belt needs
-- an essay that isn't in yet (the sending function decides).

-- ---- Settings (editable): deadline, the final prep session, and the hub key for the calls list ----
alter table public.prep_settings add column if not exists nurture_deadline     date   not null default date '2026-11-21';
alter table public.prep_settings add column if not exists prep_session_date     date   not null default date '2026-11-21';
alter table public.prep_settings add column if not exists prep_session_venue    text   not null default '47-51 Unwins Bridge Road, Sydenham';
alter table public.prep_settings add column if not exists prep_session_cost     text   not null default '$60, cash only, payable on arrival';
alter table public.prep_settings add column if not exists nurture_hub_key       text;
update public.prep_settings set nurture_hub_key = encode(gen_random_bytes(16), 'hex') where id = 1 and (nurture_hub_key is null or nurture_hub_key = '');

-- ---- The steps: one row per message, fully editable. Enrol track = fixed dates; booked track = relative to an anchor ----
create table if not exists public.prep_nurture_steps (
  step_id     uuid primary key default gen_random_uuid(),
  track       text not null check (track in ('enrol','booked')),
  code        text not null unique,                 -- stable key the sender uses
  label       text not null,                        -- shown in Settings
  day         int,                                  -- enrol track: 1,3,5,8,10,12
  channel     text not null check (channel in ('sms','email','call')),
  send_on     date,                                 -- enrol track: the date it goes out
  send_at     time not null default '10:00',        -- time of day (Sydney)
  anchor      text check (anchor in ('on_payment','prep_session','grading_day')),  -- booked track
  offset_days int not null default 0,               -- booked track: days from the anchor (e.g. -2)
  subject     text,                                 -- email subject
  body        text not null default '',
  essay_only  boolean not null default false,
  active      boolean not null default true,
  sort        int not null default 0,
  updated_at  timestamptz not null default now()
);

-- ---- Final prep-session time groups (editable): which target ranks attend which group ----
create table if not exists public.prep_time_groups (
  group_id   uuid primary key default gen_random_uuid(),
  time_label text not null,          -- e.g. "8:00 to 10:00am"
  ranks      text[] not null default '{}',   -- target ranks in this group
  sort       int not null default 0,
  updated_at timestamptz not null default now()
);

-- ---- One run per cycle: who started it, whether it's paused, the deadline ----
create table if not exists public.prep_nurture_runs (
  cycle_id   uuid primary key references public.prep_cycles on delete cascade,
  started_by text,
  started_at timestamptz,
  paused     boolean not null default false,
  deadline   date,
  updated_at timestamptz not null default now()
);

-- ---- Per student, per cycle: pauses (from a reply), a hand skip, and a grading-date override ----
create table if not exists public.prep_nurture_state (
  cycle_id             uuid not null references public.prep_cycles on delete cascade,
  student_id           text not null references public.prep_students on delete cascade,
  joined_on            date,            -- the day the sequence first saw them; steps before this aren't back-sent
  paused_until         date,            -- a reply pauses the sequence until this date
  skipped              boolean not null default false,  -- staff "Skip student"
  stopped              boolean not null default false,  -- replied STOP / not grading: never contact again
  grading_date_override date,           -- overrides the date worked out from their belt
  updated_at           timestamptz not null default now(),
  primary key (cycle_id, student_id)
);

-- ---- One row per student per step: so nothing is ever sent twice ----
create table if not exists public.prep_nurture_log (
  log_id     uuid primary key default gen_random_uuid(),
  cycle_id   uuid not null references public.prep_cycles on delete cascade,
  student_id text not null references public.prep_students on delete cascade,
  step_code  text not null,
  channel    text not null,
  status     text not null check (status in ('sent','skipped_paid','skipped_other','failed')),
  ghl_message_id text,
  error      text,
  sent_at    timestamptz not null default now(),
  unique (cycle_id, student_id, step_code)
);

-- ---- The Day 12 call list and reply-driven "concern" call-backs ----
create table if not exists public.prep_calls (
  call_id     uuid primary key default gen_random_uuid(),
  cycle_id    uuid not null references public.prep_cycles on delete cascade,
  student_id  text not null references public.prep_students on delete cascade,
  reason      text not null check (reason in ('day12','concern')),
  note        text,
  callback_on date,                     -- stays on the list until this day
  outcome     text,                     -- one of the five outcomes, once logged
  outcome_note text,
  done        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists prep_calls_cycle_idx on public.prep_calls (cycle_id, done);

-- ---- Seeds: the default wording (edit it in Settings before starting) ----
insert into public.prep_nurture_steps (track, code, label, day, channel, send_on, send_at, anchor, offset_days, subject, body, essay_only, sort) values
 ('enrol','enrol_d1_sms',  'Day 1 — SMS (enrolments open)',        1,  'sms',   date '2026-11-08','10:00', null, 0, null,
   'Hi! {first_name} has been marked on track for {belt} and is invited to grade on {grading_date}. Please enrol by Sat 21 Nov using {first_name}''s personal link: {link} - AMA', false, 10),
 ('enrol','enrol_d1_email','Day 1 — email (enrolments open)',       1,  'email', date '2026-11-08','19:00', null, 0, '{first_name} is invited to grade for {belt}',
   E'Hi,\n\nWe''re proud to let you know that {first_name} has been marked on track for {belt} and is invited to grade on {grading_date}.\n\nTo secure {first_name}''s place, please enrol and pay the grading fee by Saturday 21 November. That''s the final prep session, a practice grading with Grand Master.\n\nEnrol {first_name} now: {link}\n\n{essay}{first_name}''s black belt essay is also due before grading, and it''s on the same personal link.\n\nHere''s a taste of grading day: https://www.instagram.com/p/DaW_IkOlQbq/\n\nIf you have any questions, just reply to this email.\n\nThe AMA team', false, 20),
 ('enrol','enrol_d3_email','Day 3 — email (getting ready)',         3,  'email', date '2026-11-10','19:00', null, 0, 'Getting {first_name} ready for {grading_date}',
   E'Hi,\n\nHere''s how to make the most of the next two weeks:\n\n- Final prep session, Saturday 21 November: a practice grading with Grand Master. It''s the best preparation {first_name} can get, so please make sure they''re there.\n{essay_bullet}- Uniform: clean, and fitting well.\n\nOn grading day we start with a roll call and go straight into the grading. Parents are welcome to watch. See what it looks like: https://www.instagram.com/p/DaW_IkOlQbq/\n\nIf {first_name} isn''t enrolled yet, you can do it here: {link}\n\nThe AMA team', false, 30),
 ('enrol','enrol_d5_sms',  'Day 5 — SMS (checking in)',             5,  'sms',   date '2026-11-12','10:00', null, 0, null,
   'Hi! Just checking in. How is {first_name} feeling about the {belt} grading? If you or {first_name} have any worries about being ready, reply here and one of our instructors will give you a call. - AMA', false, 40),
 ('enrol','enrol_d8_email','Day 8 — email (questions families ask)', 8,  'email', date '2026-11-15','19:00', null, 0, 'Your grading questions, answered',
   E'Hi,\n\nThese are the questions we hear most:\n\n- When is it? {grading_date}. Your session time is on {first_name}''s personal link.\n- What does it cost? The grading fee for {belt} is shown when you enrol.\n- When do we need to enrol? By Saturday 21 November, the practice grading with Grand Master.\n- What happens on the day? A roll call, then straight into the grading.\n- Can parents come? Yes, parents are welcome to watch.\n- What if {first_name} doesn''t pass? The instructors explain what to work on, and {first_name} can grade again at a later grading.\n{essay_bullet}\nEnrol {first_name}: {link}\n\nWorried {first_name} isn''t quite ready, or have any other concerns? Reply here and an instructor will get back to you.\n\nThe AMA team', false, 50),
 ('enrol','enrol_d10_sms', 'Day 10 — SMS (enrolments close Saturday)',10, 'sms',   date '2026-11-17','10:00', null, 0, null,
   'Hi! Enrolments for {first_name}''s {belt} grading close this Saturday at the practice grading with Grand Master. If we haven''t seen it by Thursday, we''ll give you a call. Enrol here: {link} - AMA', false, 60),
 ('enrol','enrol_d12_call','Day 12 — phone call (team calls unpaid)',12, 'call',  date '2026-11-19','09:00', null, 0, null,
   'Phone call from the team — see the Black belt calls list on the hub.', false, 70),
 ('enrol','enrol_voicemail','Day 12 — voicemail text (if no answer)',12, 'sms',   null, '10:00', null, 0, null,
   'Hi, it''s AMA. We just tried calling about {first_name}''s grading on {grading_date}. Enrolments close Sat 21 Nov: {link}. Call or reply any time - AMA', false, 80),
 ('booked','booked_pay_sms',  'Booked in — SMS (on payment)',      null,'sms',  null,'10:00','on_payment', 0, null,
   'Thanks! {first_name} is booked in to grade for {belt} on {grading_date}. Next step: the practice grading with Grand Master on Sat 21 Nov, {prep_time}, at 47-51 Unwins Bridge Rd, Sydenham. - AMA', false, 110),
 ('booked','booked_pay_email','Booked in — email (on payment)',    null,'email',null,'10:00','on_payment', 0, '{first_name} is booked in for grading',
   E'Hi,\n\nThank you. {first_name} is booked in to grade for {belt} on {grading_date}. Their session time is on {first_name}''s personal link: {link}\n\nBefore grading: the final prep session is a practice grading with Grand Master on Saturday 21 November, {prep_time}, at 47-51 Unwins Bridge Road, Sydenham. It''s the best preparation {first_name} can get, so please make sure they''re there.\n\nOn grading day: we start with a roll call and go straight into the grading. Parents are welcome to stay and watch. Watch last grading''s highlights: https://www.instagram.com/p/DaW_IkOlQbq/\n\n{essay}{first_name}''s essay is still to come. Please submit it through the same personal link before grading.\n\nThe AMA team', false, 120),
 ('booked','booked_prep_email','Final prep reminder — email',      null,'email',null,'19:00','prep_session', -2, 'Saturday: {first_name}''s practice grading with Grand Master',
   E'Hi,\n\nThis Saturday, 21 November, is {first_name}''s practice grading with Grand Master, the last preparation session before grading.\n\n- When: {prep_time}\n- Where: Australian Martial Arts Academy, 47-51 Unwins Bridge Road, Sydenham\n- Bring: full uniform (dobok) and belt. All other equipment is provided.\n- Cost: $60, cash only, payable on arrival.\n- Sign in: attendance is recorded when you sign in on arrival.\n- Parents: welcome to stay and watch.\n\nSee you Saturday.\n\nThe AMA team', false, 130),
 ('booked','booked_prep_sms', 'Final prep reminder — SMS (morning)',null,'sms', null,'07:00','prep_session', 0, null,
   'Good morning! Today is {first_name}''s practice grading with Grand Master, {prep_time} at 47-51 Unwins Bridge Rd, Sydenham. Bring dobok and belt, and $60 cash. See you there! - AMA', false, 140),
 ('booked','booked_grade_email','Grading reminder — email (2 days before)',null,'email',null,'19:00','grading_day', -2, '{first_name}''s grading is on {grading_date}',
   E'Hi,\n\n{first_name}''s {belt} grading is nearly here.\n\n- When: {grading_date}. The session time is on {first_name}''s personal link: {link}\n- Where: Australian Martial Arts Academy, 47-51 Unwins Bridge Road, Sydenham\n- Arrive: in time for the roll call at the start of the session. We go straight into the grading after that.\n- Bring: full uniform (dobok) and belt. All other equipment is provided.\n- Parents: welcome to stay and watch.\n\nGood luck, {first_name}!\n\nThe AMA team', false, 150),
 ('booked','booked_grade_sms','Grading reminder — SMS (morning of)',null,'sms', null,'06:30','grading_day', 0, null,
   'Good morning! Today''s the day: {first_name}''s {belt} grading at 47-51 Unwins Bridge Rd, Sydenham. Please arrive in time for the roll call, in full dobok and belt. Good luck! - AMA', false, 160)
on conflict (code) do nothing;

insert into public.prep_time_groups (time_label, ranks, sort) values
 ('8:00 to 10:00am',    array['1st Dan Black Belt','1st Dan Level 1','3rd Dan','3rd Dan Level 1','3rd Dan Level 2','3rd Dan Level 3'], 10),
 ('10:30am to 12:30pm', array['Probationary Black Belt','1st Dan Black Belt','2nd Dan','2nd Dan Level 1','2nd Dan Level 2'], 20),
 ('1:00 to 3:00pm',     array['Probationary Black Belt'], 30),
 ('3:30 to 5:30pm',     array['2nd Dan','2nd Dan Level 1','2nd Dan Level 2','3rd Dan','3rd Dan Level 1','3rd Dan Level 2','3rd Dan Level 3','4th Dan','4th Dan Level 1','4th Dan Level 2','4th Dan Level 3','4th Dan Level 4','5th Dan'], 40)
on conflict do nothing;

-- ---- Row level security ----
alter table public.prep_nurture_steps enable row level security;
alter table public.prep_time_groups   enable row level security;
alter table public.prep_nurture_runs  enable row level security;
alter table public.prep_nurture_state enable row level security;
alter table public.prep_nurture_log   enable row level security;
alter table public.prep_calls         enable row level security;

do $$
declare t text;
begin
  -- wording and timing: everyone who can view reads; admins edit
  foreach t in array array['prep_nurture_steps','prep_time_groups'] loop
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "write" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (public.prep_can_view())', t);
    execute format('create policy "write" on public.%I for all to authenticated using (public.prep_has_role(''admin'')) with check (public.prep_has_role(''admin''))', t);
  end loop;
  -- runs / state / log / calls: grading staff (and admin) manage
  foreach t in array array['prep_nurture_runs','prep_nurture_state','prep_nurture_log','prep_calls'] loop
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "write" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (public.prep_can_view())', t);
    execute format('create policy "write" on public.%I for all to authenticated using (public.prep_has_role(''grading'')) with check (public.prep_has_role(''grading''))', t);
  end loop;
end $$;

grant select, insert, update, delete on public.prep_nurture_steps, public.prep_time_groups, public.prep_nurture_runs, public.prep_nurture_state, public.prep_nurture_log, public.prep_calls to authenticated;
