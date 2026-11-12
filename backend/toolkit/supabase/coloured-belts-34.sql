-- coloured-belts-34.sql: stop double handling and double sending.
-- 1. cb_reply_seen: GoHighLevel can deliver the same reply twice. The cb function records (who, hash of the words) and ignores
--    an identical reply from the same number/email for 15 minutes, so a family never gets the same answer twice.
create table if not exists public.cb_reply_seen (
  who     text not null,
  h       text not null,
  seen_at timestamptz not null default now(),
  primary key (who, h)
);
alter table public.cb_reply_seen enable row level security;  -- only the function (service role) uses it

-- 2. efc_hook: the nightly efc-pull records when it last ran (it already writes these; the columns were missing).
alter table public.efc_hook add column if not exists last_pull_at timestamptz;
alter table public.efc_hook add column if not exists last_pull_by text;

-- 3. cb_outbox: a row is claimed before it is texted, so two overlapping runs never send it twice.
alter table public.cb_outbox add column if not exists claimed_at timestamptz;
