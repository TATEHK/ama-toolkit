-- cb-helpers-send.sql (21 Nov 2026): text + email a grading helper their sign-up link (Grading Helpers admin > Invite > Send).
alter table public.cb_helpers add column if not exists sent_at timestamptz;   -- when their link was last sent
alter table public.cb_messages drop constraint if exists cb_messages_kind_check;
alter table public.cb_messages add constraint cb_messages_kind_check check (kind = any (array['invite','not_booked','reminder','unpaid','congrats','retest','not_ready','photo',
  'email_booked','email_paid','bbc_followup','seq','seq_test','sms_backup','alt_offer','belt_fix','sms_booked','sms_paid','helper_invite']));
-- Little Dragons gradings are hidden from helpers except the ones staff tick (Invite tab > Little Dragons)
alter table public.cb_helpers add column if not exists little_dragons boolean not null default false;
