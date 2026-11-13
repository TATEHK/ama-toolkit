-- coloured-belts-35.sql: confirmation SMS. A short text goes to the family once a grading is booked or paid,
-- mirroring the confirmation email. Logged in cb_messages like the emails, so it is only ever sent once.
alter table public.cb_messages drop constraint if exists cb_messages_kind_check;
alter table public.cb_messages add constraint cb_messages_kind_check check (kind = any (array[
  'invite','not_booked','reminder','unpaid','congrats','retest','not_ready','photo',
  'email_booked','email_paid','bbc_followup','seq','seq_test','sms_backup','alt_offer','belt_fix',
  'sms_booked','sms_paid']));
