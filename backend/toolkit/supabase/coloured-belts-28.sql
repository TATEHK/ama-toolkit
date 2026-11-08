-- Coloured belt grading, update 28: texts that GoHighLevel fails, and its daily SMS limit.
-- GoHighLevel accepts a text and can fail it afterwards (for example at its daily SMS limit), so the "cb" function now keeps
-- each text's GoHighLevel message id, checks its real status on a later run, emails the same words instead when it failed,
-- and stops texting until the limit resets (cb_settings.sms_blocked_until). Invitation texts are capped per day (sms_daily_cap).
-- Safe to run more than once.

alter table public.cb_messages add column if not exists ghl_id text, add column if not exists verified_at timestamptz;
create index if not exists cb_messages_unverified on public.cb_messages (sent_at) where ghl_id is not null and verified_at is null;

alter table public.cb_settings add column if not exists sms_blocked_until timestamptz,
  add column if not exists sms_daily_cap int not null default 450;

-- Email backups are logged as their own kind
alter table public.cb_messages drop constraint if exists cb_messages_kind_check;
alter table public.cb_messages add constraint cb_messages_kind_check check (kind = any (array['invite','not_booked','reminder','unpaid','congrats','retest','not_ready','photo','email_booked','email_paid','bbc_followup','seq','seq_test','sms_backup']));

-- cb-check (a separate function) records what GoHighLevel actually did with a text
create table if not exists public.cb_ghl_check (message_id uuid primary key, ghl_status text, ghl_error text, checked_at timestamptz);
alter table public.cb_ghl_check enable row level security;
