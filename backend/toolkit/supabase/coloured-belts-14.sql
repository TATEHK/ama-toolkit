-- AMA Toolkit: coloured belt grading, update 14 (Black Belt Club follow-ups)
-- Run once in Supabase > SQL Editor, after coloured-belts-13.sql. Safe to run again.
-- Two weeks after a Black Belt Club card is written, anyone who hasn't joined comes up on Cards to write as a follow-up,
-- with a text to the parent (sent through GoHighLevel like the other texts, and logged as 'bbc_followup').

alter table public.cb_settings add column if not exists bbc_followup_text text not null
  default 'Hi {parent}, just checking in about {first}''s Black Belt Club invitation. Have a chat with us at your next class. AMA {school}';

alter table public.cb_messages drop constraint if exists cb_messages_kind_check;
alter table public.cb_messages add constraint cb_messages_kind_check
  check (kind in ('invite', 'not_booked', 'reminder', 'unpaid', 'congrats', 'retest', 'not_ready', 'photo', 'email_booked', 'email_paid', 'bbc_followup'));
