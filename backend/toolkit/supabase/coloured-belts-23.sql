-- AMA Toolkit: coloured belt grading, update 23 (the automated booking sequence)
-- Run once in Supabase > SQL Editor, after coloured-belts-22.sql. Safe to run again.
--
-- Every coloured belt family gets one sequence. It starts when the student is added to a grading day (the invitation
-- goes out, so staff no longer press Send) and runs until they are booked and paid; if they never book it ends with a
-- staff call 5 days before the grading. Then the booked-in messages take over. Black belt days (bb) are left out.
--
--   cb_seq_steps   each step: when (from the invitation, from the grading date, a fixed date, or when paid), channel,
--                  send time, who it goes to, and its wording. Admins edit the wording in Settings.
--   cb_seq_log     one row per student per step, unique, so nothing is ever sent twice (also records skipped/missed).
--   cb_calls       the staff call list (not booked by G-5, or a family replied with a concern), shown on My Day in the hub.
--   cb_prep_bookings  who booked the Colour Belt Prep Session (pushed by the hub every hour through cb_prep_sync).
--   cb_outbox      texts a staff call outcome asks for (send the link again, "we tried calling"), sent on the next run.
--
-- The sequence is OFF until cb_settings.seq_on is switched on (Settings > Booking sequence). "Send test to me" works while off.
-- The "cb" function runs every 15 minutes (pg_cron) and only sends between 8:00am and 7:30pm Sydney time.

-- ---------- Switch, prep session details and the new fields ----------
alter table public.cb_settings add column if not exists seq_on boolean not null default false;
alter table public.cb_settings add column if not exists seq_on_at timestamptz;          -- when it was last switched on
alter table public.cb_settings add column if not exists seq_on_by text;
alter table public.cb_settings add column if not exists deadline_days int not null default 7;   -- {deadline}: grading date minus this many days
alter table public.cb_settings add column if not exists prep_date date default '2026-11-22';
alter table public.cb_settings add column if not exists prep_closes date default '2026-11-19';
alter table public.cb_settings add column if not exists prep_url text default 'https://train.australianmartialarts.com.au/colour-belt-prep';

-- Per student: a reply pauses the sequence for 2 days; STOP or "Skip" stops it for good
alter table public.cb_entries add column if not exists seq_paused_until timestamptz;
alter table public.cb_entries add column if not exists seq_stopped_at timestamptz;
alter table public.cb_entries add column if not exists seq_stopped_why text;            -- STOP, DND, Skipped by staff, Not grading

-- Message kinds the sequence logs in cb_messages (with the existing ones)
alter table public.cb_messages drop constraint if exists cb_messages_kind_check;
alter table public.cb_messages add constraint cb_messages_kind_check
  check (kind in ('invite', 'not_booked', 'reminder', 'unpaid', 'congrats', 'retest', 'not_ready', 'photo', 'email_booked', 'email_paid', 'bbc_followup', 'seq', 'seq_test'));

-- ---------- Steps ----------
create table if not exists public.cb_seq_steps (
  code       text primary key,
  track      text not null check (track in ('booking', 'prep', 'booked')),
  label      text not null,
  channel    text not null check (channel in ('sms', 'email', 'call')),
  anchor     text not null check (anchor in ('invite', 'grading', 'date', 'paid')),
  offset_days int not null default 0,       -- invite/grading: days after (negative = before); paid: 0 = straight away
  send_date  date,                          -- anchor 'date': the day it goes
  send_at    time,                          -- Sydney time; null = straight away (within sending hours)
  audience   text not null default 'not_paid' check (audience in ('not_paid', 'not_booked', 'paid', 'prep_not_booked', 'prep_booked')),
  template   text,                          -- the wording, or the Settings column it uses: 'settings:reminder_text'
  subject    text,                          -- emails
  active     boolean not null default true,
  sort       int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.cb_seq_log (
  entry_id  uuid not null references public.cb_entries(entry_id) on delete cascade,
  step_code text not null,
  status    text not null check (status in ('sending', 'sent', 'test', 'failed', 'skipped', 'missed')),
  why       text,
  at        timestamptz not null default now(),
  primary key (entry_id, step_code)
);

create table if not exists public.cb_calls (
  call_id     uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references public.cb_entries(entry_id) on delete cascade,
  reason      text not null check (reason in ('not_booked', 'concern')),
  note        text,                         -- for a concern: what they replied
  callback_on date,                         -- on the list from this day
  outcome     text,
  outcome_note text,
  tries       int not null default 0,       -- no-answer tries
  done        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists cb_calls_open on public.cb_calls (done, callback_on);

create table if not exists public.cb_prep_bookings (
  member_key   text primary key,            -- 'efc:<EFC member id>'
  full_name    text,
  session_time text,                        -- e.g. "9:00am", fills {prep_time}
  updated_at   timestamptz not null default now()
);

create table if not exists public.cb_outbox (
  out_id    uuid primary key default gen_random_uuid(),
  entry_id  uuid not null references public.cb_entries(entry_id) on delete cascade,
  kind      text not null check (kind in ('send_link', 'no_answer')),
  created_at timestamptz not null default now(),
  sent_at   timestamptz,
  status    text,
  error     text
);

-- ---------- Row level security: staff read; admins edit the wording; everything else through the function ----------
alter table public.cb_seq_steps     enable row level security;
alter table public.cb_seq_log       enable row level security;
alter table public.cb_calls         enable row level security;
alter table public.cb_prep_bookings enable row level security;
alter table public.cb_outbox        enable row level security;
do $$
declare t text;
begin
  foreach t in array array['cb_seq_steps', 'cb_seq_log', 'cb_calls', 'cb_prep_bookings', 'cb_outbox'] loop
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (public.prep_has_role(''instructor'', ''grading'', ''payments''))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  execute 'drop policy if exists "write" on public.cb_seq_steps';
  execute 'create policy "write" on public.cb_seq_steps for update to authenticated using (public.prep_has_role(''admin'')) with check (public.prep_has_role(''admin''))';
  execute 'grant update (template, subject, active, send_at, updated_at) on public.cb_seq_steps to authenticated';
end $$;

-- Grading staff pause / skip / resume a student's sequence (the app's Sequence screen)
create or replace function public.cb_seq_set(p_entry uuid, p_what text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('grading') then raise exception 'Only grading staff can change the sequence.' using errcode = '42501'; end if;
  if p_what = 'pause' then update cb_entries set seq_paused_until = now() + interval '2 days' where entry_id = p_entry;
  elsif p_what = 'skip' then update cb_entries set seq_stopped_at = now(), seq_stopped_why = 'Skipped by staff' where entry_id = p_entry;
  elsif p_what = 'resume' then update cb_entries set seq_paused_until = null, seq_stopped_at = null, seq_stopped_why = null where entry_id = p_entry;
  else raise exception 'Unknown change.'; end if;
end $$;
revoke all on function public.cb_seq_set(uuid, text) from public, anon;
grant execute on function public.cb_seq_set(uuid, text) to authenticated;

-- Admins switch the whole sequence on or off
create or replace function public.cb_seq_switch(p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('admin') then raise exception 'Only an admin can switch the sequence on or off.' using errcode = '42501'; end if;
  update cb_settings set seq_on = p_on, seq_on_at = case when p_on then now() else seq_on_at end, seq_on_by = case when p_on then public.prep_email() else seq_on_by end where id = 1;
end $$;
revoke all on function public.cb_seq_switch(boolean) from public, anon;
grant execute on function public.cb_seq_switch(boolean) to authenticated;

-- ---------- The prep session list from the hub (same key as the skip list) ----------
-- POST /rest/v1/rpc/cb_prep_sync  { "p_key": "<skip key>", "p_rows": [{ "efc_id": "...", "name": "...", "time": "9:00am" }] }
create or replace function public.cb_prep_sync(p_key text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  if p_key is null or not exists (select 1 from cb_settings where skip_key = p_key) then raise exception 'Wrong key.'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'p_rows must be a list.'; end if;
  delete from cb_prep_bookings;
  for r in select * from jsonb_array_elements(p_rows) loop
    continue when nullif(btrim(r->>'efc_id'), '') is null;
    insert into cb_prep_bookings (member_key, full_name, session_time, updated_at)
    values ('efc:' || btrim(r->>'efc_id'), nullif(btrim(r->>'name'), ''), left(nullif(btrim(r->>'time'), ''), 20), now())
    on conflict (member_key) do update set full_name = excluded.full_name, session_time = excluded.session_time, updated_at = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'booked', n);
end $$;
revoke all on function public.cb_prep_sync(text, jsonb) from public;
grant execute on function public.cb_prep_sync(text, jsonb) to anon, authenticated;

-- ---------- Calls on My Day (same key as the skip list; the hub shows them to that school's rostered staff and Mark) ----------
create or replace function public.cb_calls_due(p_key text)
returns table (call_id uuid, entry_id uuid, school text, parent text, mobile text, student text, belt_from text, belt_to text,
               grading_date date, reason text, note text, tries int, callback_on date)
language sql security definer set search_path = public as $$
  select c.call_id, c.entry_id, coalesce(m.location, d.location), coalesce(nullif(m.guardian_name, ''), m.full_name),
         coalesce(nullif(m.guardian_phone, ''), m.phone), e.full_name, e.belt_from, e.belt_to, d.grading_date, c.reason, c.note, c.tries, c.callback_on
    from cb_calls c
    join cb_entries e on e.entry_id = c.entry_id
    join cb_days d on d.day_id = e.day_id
    left join efc_members m on m.member_key = e.member_key
   where p_key is not null and p_key <> '' and exists (select 1 from cb_settings where skip_key = p_key)
     and not c.done and not coalesce(e.paid, false) and e.result is null and not d.closed and e.seq_stopped_at is null
     and (c.callback_on is null or c.callback_on <= (now() at time zone 'Australia/Sydney')::date)
   order by d.grading_date, e.full_name;
$$;

-- Outcomes: send_link, will_book, call_back, not_grading, no_answer, wrong_number
create or replace function public.cb_call_outcome(p_key text, p_entry uuid, p_outcome text, p_note text default null, p_callback date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare c record; today date := (now() at time zone 'Australia/Sydney')::date;
begin
  if p_key is null or p_key = '' or not exists (select 1 from cb_settings where skip_key = p_key) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  if p_outcome not in ('send_link', 'will_book', 'call_back', 'not_grading', 'no_answer', 'wrong_number') then raise exception 'Unknown outcome.'; end if;
  select * into c from cb_calls where entry_id = p_entry and not done order by created_at desc limit 1;
  if c.call_id is null then return 0; end if;
  if p_outcome = 'call_back' and p_callback is null then raise exception 'Pick the day to call back.'; end if;
  update cb_calls set outcome = p_outcome, outcome_note = p_note, updated_at = now(),
         tries = tries + case when p_outcome = 'no_answer' then 1 else 0 end,
         callback_on = case p_outcome when 'will_book' then today + 2 when 'call_back' then p_callback
                                      when 'no_answer' then today + 1 when 'send_link' then today + 2 else callback_on end,
         -- a call is finished when they're not grading, the number is wrong (front desk), or two tries got no answer
         done = p_outcome in ('not_grading', 'wrong_number') or (p_outcome = 'no_answer' and tries + 1 >= 2)
   where call_id = c.call_id;
  if p_outcome in ('send_link', 'no_answer') then insert into cb_outbox (entry_id, kind) values (p_entry, p_outcome); end if;
  if p_outcome = 'not_grading' then
    -- Removed from the grading day (never once booked or paid), so the sequence stops
    delete from cb_entries where entry_id = p_entry and not coalesce(paid, false) and booked_at is null;
    update cb_entries set seq_stopped_at = now(), seq_stopped_why = 'Not grading' where entry_id = p_entry;
  end if;
  return 1;
end $$;
revoke all on function public.cb_calls_due(text) from public;
revoke all on function public.cb_call_outcome(text, uuid, text, text, date) from public;
grant execute on function public.cb_calls_due(text) to anon, authenticated;
grant execute on function public.cb_call_outcome(text, uuid, text, text, date) to anon, authenticated;

-- ---------- The steps, with Mark's wording (7 Nov doc). Only added when missing, so edits in Settings are kept. ----------
insert into public.cb_seq_steps (code, track, label, channel, anchor, offset_days, send_date, send_at, audience, subject, template, sort) values
 ('invite_sms', 'booking', 'Day 0: invitation text', 'sms', 'invite', 0, null, null, 'not_paid', null,
  E'Hi {parent}, {first} is preparing for their {next} grading at AMA {school} on {date}{time}. Please reply YES to confirm their intention to grade, and the official invitation will follow. {video}\n{prep} AMA {school}', 10),
 ('invite_email', 'booking', 'Day 0: invitation email', 'email', 'invite', 0, null, null, 'not_paid', '{first}''s {next} grading invitation: {date}',
  E'Hi {parent},\nIt''s grading time! {first} is invited to grade for their {next} at AMA {school}, and we''d love to see them there.\n## Grading details\n• Date: {date}\n• Time: {time_only}\n• Where: AMA {school}\n• Grading fee: {fee}, paid when you book\n• Book by: {deadline}\n## What to do now\nReply YES to our text (or to this email) to confirm {first} intends to grade. We''ll then send the official invitation with the booking link. {first}''s place is confirmed once it''s booked and paid.\n## Getting ready\n• Practise at home with the grading video: {video_link}\n• Keep training: regular classes between now and {date} are the best preparation.\n• Colour Belt Prep Session: {prep}\n## On the day\n• Arrive 15 minutes early.\n• Wear full uniform and current belt.\n• Bring: {bring}\n• Parents and family are welcome to watch.\nAny questions, just reply to this email or call us on {phone}.\nAMA {school}', 20),
 ('nudge_d2', 'booking', 'Day 2: nudge text', 'sms', 'invite', 2, null, '10:00', 'not_booked', null,
  'Hi {parent}, just checking you saw {first}''s grading invitation for {date}. Book their spot here before {deadline}: {link} AMA {school}', 30),
 ('ready_d4', 'booking', 'Day 4: getting ready email', 'email', 'invite', 4, null, '19:00', 'not_paid', 'Getting {first} ready for their {next} grading',
  E'Hi {parent},\nHere''s how to help {first} make the most of the next few weeks:\n• Practise with the grading video: {video_link}\n• Regular classes: the more {first} trains before {date}, the more confident they''ll feel.\n• Colour Belt Prep Session: {prep}\nIf {first} isn''t booked in yet, please book before {deadline}:\n[Book {first}''s grading]({link})\nAMA {school}', 40),
 ('checkin_d6', 'booking', 'Day 6: check-in text', 'sms', 'invite', 6, null, '10:00', 'not_paid', null,
  'Hi {parent}, just checking in. How is {first} feeling about their {next} grading? If you have any worries about them being ready, reply here and one of our instructors will give you a call. AMA {school}', 50),
 ('close_g8', 'booking', 'G-8: bookings close text', 'sms', 'grading', -8, null, '10:00', 'not_paid', null,
  'Hi {parent}, bookings for {first}''s {next} grading on {date} close tomorrow. Book here: {link}. If we haven''t seen it by then, one of our team will give you a call. AMA {school}', 60),
 ('call_g5', 'booking', 'G-5: staff call on My Day', 'call', 'grading', -5, null, '07:00', 'not_paid', null, null, 70),
 ('prep_last', 'prep', 'Tue 17 Nov: prep session last chance text', 'sms', 'date', 0, '2026-11-17', '10:00', 'prep_not_booked', null,
  'Hi {parent}, last chance to book {first} into the Colour Belt Prep Session this Sunday 22 Nov at Marrickville. Bookings close Thursday: {prep_link} AMA {school}', 80),
 ('prep_remind', 'prep', 'Fri 20 Nov: prep session reminder text', 'sms', 'date', 0, '2026-11-20', '10:00', 'prep_booked', null,
  'Hi {parent}, a reminder that {first} is booked into the Colour Belt Prep Session this Sunday 22 Nov at AMA Marrickville{prep_time}. Please wear uniform and belt and bring a water bottle. See you there! AMA {school}', 90),
 ('prep_morning', 'prep', 'Sun 22 Nov: prep session morning-of text', 'sms', 'date', 0, '2026-11-22', '08:00', 'prep_booked', null,
  'Good morning {parent}! {first}''s Colour Belt Prep Session is today at AMA Marrickville{prep_time}. See you soon! AMA {school}', 100),
 ('booked_sms', 'booked', 'Booked and paid text', 'sms', 'paid', 0, null, null, 'paid', null,
  'Thanks {parent}! {first} is booked in for their {next} grading at AMA {school} on {date}{time}. See you there! AMA {school}', 110),
 ('reminder_g2', 'booked', 'G-2: grading reminder (Settings wording)', 'sms', 'grading', -2, null, '10:00', 'paid', null, 'settings:reminder_text', 120),
 ('morning_g', 'booked', 'Morning of the grading text', 'sms', 'grading', 0, null, '08:00', 'paid', null,
  'Good morning {parent}! Today''s the day: {first}''s {next} grading at AMA {school}{time}. Good luck {first}! AMA {school}', 130)
on conflict (code) do nothing;

-- The two texts a staff call outcome sends (editable like the others; never scheduled on their own)
insert into public.cb_seq_steps (code, track, label, channel, anchor, offset_days, audience, template, active, sort) values
 ('out_send_link', 'booking', 'Call outcome "Send link": the booking link (official invitation wording)', 'sms', 'date', 0, 'not_paid', 'settings:not_booked_text', true, 200),
 ('out_no_answer', 'booking', 'Call outcome "No answer": we tried calling', 'sms', 'date', 0, 'not_paid',
  'Hi {parent}, we just tried calling about {first}''s grading on {date}. Book here: {link}, or reply any time. AMA {school}', true, 210)
on conflict (code) do nothing;

-- ---------- Every 15 minutes: ask the "cb" function to send what's due (Supabase only: pg_cron, pg_net, Vault) ----------
-- Uses the same Vault secret as the nightly photo clean-up (coloured-belts-6.sql). Sends nothing while seq_on is off.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net')
     and exists (select 1 from pg_extension where extname = 'supabase_vault') then
    if not exists (select 1 from vault.secrets where name = 'cb_cron_secret') then
      perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'cb_cron_secret', 'Lets scheduled jobs call the cb function');
    end if;
    perform cron.unschedule('cb-sequence') where exists (select 1 from cron.job where jobname = 'cb-sequence');
    perform cron.schedule('cb-sequence', '*/15 * * * *', $job$
      select net.http_post(url := 'https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/cb',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cb-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'cb_cron_secret')),
        body := '{"action":"sequence"}'::jsonb,
        timeout_milliseconds := 150000)   -- a busy run takes longer than the 5-second default
    $job$);
  end if;
end $$;
