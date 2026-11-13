-- coloured-belts-35.sql: double grading — re-book flag.
-- When a second grading forces the dates to swap, an already booked/paid lower grading is moved to the earlier day.
-- The payment stays attached to the entry, but EFC bookings are tied to a day's session and the toolkit can't cancel
-- one on its own, so the moved entry is flagged: staff move them to the new session in EFC, then clear the flag.
alter table public.cb_entries add column if not exists efc_rebook_at timestamptz;
comment on column public.cb_entries.efc_rebook_at is
  'Set when a booked/paid entry is moved to another day by a double grading. Staff must move them to the new session in EFC (cancel the old booking, book the new one), then clear it.';
