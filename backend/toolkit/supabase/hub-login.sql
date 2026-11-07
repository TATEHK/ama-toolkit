-- AMA Toolkit: sign in with the AMA Admin Hub mobile and PIN
-- Run once in Supabase > SQL Editor. Safe to run again.
-- Links a hub mobile number to an AMA Toolkit login (email). The "hub" function checks the mobile and PIN with the
-- hub (Apps Script), then signs the person in as the linked login, so every existing permission in AMA ID Cards,
-- Black Belt Prep and the TV applies unchanged. Admins set the link on the Staff logins page.
-- Only the "hub" and "staff" functions read or change this table (no access from the apps themselves).

create table if not exists public.hub_logins (
  email      text primary key,                                        -- the AMA Toolkit login
  mobile9    text not null unique check (mobile9 ~ '^[0-9]{9}$'),     -- last 9 digits, as the hub stores it
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.hub_logins enable row level security;
revoke all on public.hub_logins from anon, authenticated;
