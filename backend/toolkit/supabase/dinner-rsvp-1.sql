-- 4th Dan+ celebration dinner RSVP capture (one-off, Nov 2026).
-- Guests reply YES/NO by text to the invite; the cb `reply` handler matches the sender's number here and records
-- the response. A scheduled sync writes the result into the Google Sheet (Guest List tab) for the live dashboard.
--  - phone9: last 9 digits of the mobile, matched against the inbound reply's number.
--  - sheet_row: the guest's row in the Google Sheet, so the sync updates the right line.
--  - status: invited -> yes | no. synced_at: null until the Sheet has the response.
create table if not exists public.dinner_rsvp (
  id           bigint generated always as identity primary key,
  name         text,
  phone9       text,
  sheet_row    integer,
  status       text not null default 'invited',
  reply_text   text,
  responded_at timestamptz,
  synced_at    timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists dinner_rsvp_phone9_idx on public.dinner_rsvp(phone9);
