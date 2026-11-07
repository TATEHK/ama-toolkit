-- AMA Toolkit: coloured belt grading, update 16 (families reply YES to the grading text)
-- Run once in Supabase > SQL Editor, after coloured-belts-15.sql. Safe to run again.
--
-- The first grading text asks families to reply YES to confirm they intend to grade. A GoHighLevel workflow
-- ("Customer replied", AMA sub-account) forwards every SMS reply to the "cb" function:
--   POST https://<project>.supabase.co/functions/v1/cb   { "action": "reply", "key": "<reply_key>", "phone": "{{contact.phone}}", "message": "{{message.body}}" }
-- A YES marks each of that family's invited (not yet booked) students for a coming grading day as "Said YES" and texts
-- them the booking link straight away, using the "Reminder to book" wording (the official invitation). Other replies are
-- kept on the student so staff can see them.

alter table public.cb_entries add column if not exists yes_at timestamptz;     -- replied YES (the booking link was texted then)
alter table public.cb_entries add column if not exists reply_text text;        -- their latest reply, whatever it said
alter table public.cb_entries add column if not exists reply_at timestamptz;
alter table public.cb_settings add column if not exists reply_key text not null default replace(gen_random_uuid()::text, '-', '');
