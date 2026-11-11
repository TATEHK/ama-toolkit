-- AMA Toolkit: coloured belt grading, update 32 (alert a staff number when a fee is paid)
-- Run once in Supabase > SQL Editor, after coloured-belts-31.sql. Safe to run again.
--
-- Optional per-entry "text this number once the grading fee is paid" — used for one-off payment links
-- where a staff member wants an SMS the moment it lands. Set cb_entries.notify_paid_to to the mobile;
-- the cb function texts it once (recording notify_paid_sent_at) when the Stripe payment completes.

alter table public.cb_entries add column if not exists notify_paid_to text;
alter table public.cb_entries add column if not exists notify_paid_sent_at timestamptz;
