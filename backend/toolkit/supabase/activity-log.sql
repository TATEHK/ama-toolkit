-- Activity log, risk alerts and 24-hour undo (22 Nov 2026).
-- One place that records who did what, across Coloured Belts, Black Belt Gradings, Helpers and ID cards.
-- High-risk actions alert Tate (and anyone he picks) straight away with an Undo link; the rest go in a daily summary.
-- Every risky write snapshots the before-state so it can be reversed for a window (default 24h).
-- Additive only: creating these tables changes nothing in the live apps until the actions are wired to write here.
-- The existing toolkit_audit (Staff logins history) stays as it is; this is the broader, app-wide log.

create table if not exists public.activity_log (
  id          uuid primary key default gen_random_uuid(),
  at          timestamptz not null default now(),
  actor_email text,                         -- who did it (the signed-in staff login)
  actor_name  text,
  app         text not null,                -- cb | bb | cards | helpers | staff
  action      text not null,                -- machine key, e.g. 'payment.record', 'fee.set', 'belt.change', 'texts.bulk', 'entry.delete', 'perms.change'
  risk        text not null default 'normal' check (risk in ('high','normal')),
  summary     text not null,                -- human line, e.g. "Bianca recorded $70 paid for Max Mitchell"
  target      text,                         -- what/who it touched (a name, a day, a count)
  count       int,                          -- how many rows it affected (bulk sends, bulk changes)
  snapshot    jsonb,                        -- before-state for undo (null = not reversible)
  undo        jsonb,                        -- how to reverse it: { table, key:{col:val}, set:{col:val} } or a list of these
  undo_token  text unique,                  -- the code in the Undo link
  undo_expires timestamptz,                 -- after this, the Undo link stops working
  undone_at   timestamptz,
  undone_by   text,
  alerted_at  timestamptz,                  -- when the instant alert went out (null = not alerted, or went in the daily summary)
  summarised_at timestamptz                 -- when it was included in a daily summary
);
create index if not exists activity_log_at on public.activity_log (at desc);
create index if not exists activity_log_risk_at on public.activity_log (risk, at desc);
create index if not exists activity_log_actor on public.activity_log (actor_email, at desc);
alter table public.activity_log enable row level security;   -- only the edge functions (service role) read/write it

-- One row of settings for the alerts.
create table if not exists public.alert_settings (
  id            int primary key default 1 check (id = 1),
  -- which actions alert instantly; everything else goes to the daily summary. Sensible high-risk default:
  high_actions  text[] not null default array[
    'texts.bulk','entry.delete','day.delete','fee.set','discount.set','payment.record','payment.unset',
    'result.change','belt.change','perms.change','access.remove','helper.purge'],
  scope         text not null default 'everyone' check (scope in ('everyone','selected')),  -- whose actions count
  scope_emails  text[] not null default '{}',                                               -- when scope = 'selected'
  daily_summary boolean not null default true,
  summary_hour  int not null default 7,       -- local-time hour the daily summary is sent
  undo_hours    int not null default 24,
  updated_at    timestamptz not null default now()
);
insert into public.alert_settings (id) values (1) on conflict (id) do nothing;
alter table public.alert_settings enable row level security;

-- Who gets the alerts (Tate, plus anyone he adds).
create table if not exists public.alert_recipients (
  id       uuid primary key default gen_random_uuid(),
  name     text,
  sms      text,                 -- mobile for texts (E.164 or local)
  email    text,
  channel  text not null default 'both' check (channel in ('sms','email','both')),
  active   boolean not null default true,
  added_at timestamptz not null default now()
);
alter table public.alert_recipients enable row level security;
