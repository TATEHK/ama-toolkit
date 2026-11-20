-- Grading helpers: invite-only sign-up for select black belts to help at grading days.
-- Served by the cb edge function (service role): helper_info / helper_toggle (token, public),
-- and helper_admin_days / helper_admin_day_set / helper_roster / helper_invite (staff auth).

alter table public.cb_days add column if not exists helper_open boolean not null default false;   -- open this day for helper sign-up
alter table public.cb_days add column if not exists helper_cap int not null default 8;             -- how many helpers wanted
alter table public.cb_days add column if not exists helper_audience text;                          -- coloured belt days: 'kids' | '13+' | 'all' (null = all)

-- the invited helpers (a select black belt gets a personal link)
create table if not exists public.cb_helpers (
  helper_id  uuid primary key default gen_random_uuid(),
  member_key text not null unique,
  efc_ref    text,
  full_name  text not null,
  token      text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  invited_at timestamptz
);

-- who put their hand up for which grading day
create table if not exists public.cb_helper_signups (
  helper_id  uuid not null references public.cb_helpers(helper_id) on delete cascade,
  day_id     uuid not null references public.cb_days(day_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (helper_id, day_id)
);
create index if not exists cb_helper_signups_day on public.cb_helper_signups(day_id);

-- locked down: only the edge function (service role) touches these; no anon/auth access
alter table public.cb_helpers enable row level security;
alter table public.cb_helper_signups enable row level security;
