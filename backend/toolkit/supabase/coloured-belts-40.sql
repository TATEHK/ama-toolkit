-- Black Belt Club welcome flow (coloured-belts-40).
-- When a coloured-belt grading closes, students who were invited to Black Belt Club (efc_members.bbc_invited_at)
-- and aren't already in it get a welcome email + SMS with a personal landing link, then a few touch-point nudges.
-- Signing up on the page, or joining in person (the nightly EFC sync sets bbc_seen_at -> cb_students.black_belt_club),
-- stops the rest. Sign-ups are exposed as a feed for Mark's hub to action.

-- Settings for the landing page + offer (editable without a redeploy).
alter table public.cb_settings add column if not exists bbc_video_url   text;
alter table public.cb_settings add column if not exists bbc_weekly       integer not null default 20;
alter table public.cb_settings add column if not exists bbc_uniform_full numeric not null default 130;
alter table public.cb_settings add column if not exists bbc_uniform_now  numeric not null default 65;

-- Marks a closed grading day as already turned into Black Belt Club flows (so the cron does it once).
alter table public.cb_days add column if not exists bbc_welcomed_at timestamptz;

-- One row per student in the welcome flow. token drives their landing link (/black-belt-club/#t=<token>).
create table if not exists public.cb_bbc_flow (
  member_key   text primary key,
  token        text not null unique default translate(left(encode(decode(replace(gen_random_uuid()::text,'-',''),'hex'),'base64'),22),'+/','-_'),
  full_name    text,
  phone        text,
  email        text,
  day_id       uuid references public.cb_days(day_id) on delete set null,
  started_at   timestamptz not null default now(),
  step         integer not null default 0,          -- highest touch-point already sent
  signed_at    timestamptz,                         -- they enrolled on the landing page
  uniform_claim boolean not null default false,
  sub_consent  boolean not null default false,
  status       text not null default 'active',      -- active | signed | joined | done
  feed_seen_at timestamptz,                          -- Mark's hub has picked this sign-up up
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists cb_bbc_flow_status_idx on public.cb_bbc_flow(status);

-- The touch-point templates. {{name}} and {{link}} are filled per student. Edit the wording here anytime.
create table if not exists public.cb_bbc_steps (
  step         integer primary key,
  offset_days  integer not null,
  channel      text not null default 'sms',          -- sms | email | both
  sms_body     text,
  email_subject text,
  email_body   text,
  active       boolean not null default true
);

insert into public.cb_bbc_steps (step, offset_days, channel, sms_body, email_subject, email_body) values
 (1, 0, 'both',
  'Hi {{name}}, you''ve been invited to join the AMA Black Belt Club — our program for students serious about earning their black belt. Watch Grandmaster Ridvan''s message and claim your half-price uniform here: {{link}}',
  'You''re invited to the Black Belt Club',
  E'Hi {{name}},\n\nIt''s official — you''ve been invited to join the Australian Martial Arts Black Belt Club, our program for the students we believe can go all the way to black belt and beyond.\n\nWatch Grandmaster Ridvan''s message, see what''s included, and claim your half-price uniform ($65, normally $130): {{link}}\n\nSee you on the mats,\nThe AMA Team'),
 (2, 3, 'sms',
  'Hi {{name}}, did you get to watch Grandmaster Ridvan''s message about the Black Belt Club? It''s a big step towards your black belt — have a look when you get a moment: {{link}}',
  null, null),
 (3, 7, 'both',
  '{{name}}, your Black Belt Club half-price uniform ($65, normally $130) is still reserved for you. Join the program and claim it here: {{link}}',
  'Your half-price uniform is still reserved',
  E'Hi {{name}},\n\nJust a reminder that your Black Belt Club spot — and your half-price uniform ($65, normally $130) — are still waiting for you.\n\nJoin here: {{link}}\n\nThe AMA Team'),
 (4, 14, 'sms',
  'Hi {{name}}, not ready to join the Black Belt Club right now? That''s ok — we''ll keep helping you progress in your regular program, and we''re here to help you take your training up a level whenever the time suits. If you''d like to join: {{link}}',
  null, null)
on conflict (step) do nothing;
