-- TV display: database setup
-- Run in Supabase > SQL Editor (choose "with RLS" if asked). Safe to run again.
--
-- Slides for the dojang TV. Staff with the TV editor ticked (see "Who can use the TV" below) edit them on
-- the editor page. The TV itself doesn't sign in:
-- it shows the slideshow once the screen code (Settings on the editor page) is entered, and only
-- gets what's on screen (slides, plus the live AMA info below).
--
-- Live slides fill themselves in:
--   next_grading  the next grading date of the active cycle (from Black Belt Prep)
--   events        this month's events (and next month's near the end of the month), from tv_events
--   month         "This is the Month of ...", from tv_months
--   birthdays     members with a birthday today (from efc_members), shown as first name + last initial, no age.
--                 Current members only (status Enrolled). The slide only shows on days someone has a birthday.
--
-- Countdown slides: "Black belt grading in 12 days", to a set date or the next grading in Black Belt Prep.
-- They stop showing once the day has passed.
--
-- Booked parties: party mode switches on and off by itself at the booked times.
--
-- TV status: the TV checks in every 20 seconds (tv_checkin) with what it's showing, so the editor can show
-- whether it's online. "Refresh the TV" in the editor asks it to reload.
--
-- Party mode: the TV shows only one slide (e.g. a birthday message) until a set time, then goes back to
-- the normal slideshow by itself. That slide is kept out of the normal slideshow so it can be reused.

-- ---------- Who can use the TV ----------
-- TV permissions, ticked on the Staff logins page (staff/):
--   edit     everything below (the full TV editor) — the umbrella grant
--   slides   the slideshow content only: add/edit/reorder/hide slides, per-slide timing, events,
--            month themes and party designs (NOT screen codes, kiosk or sign-in settings)
--   screens  the device side only: screen codes, kiosk/FreeKiosk and sign-in settings, blackout hours,
--            party mode on/off and the phone remote (NOT editing slide content)
--   party    party mode only: start, stop and book parties, birthday posters and saved designs
--   remote   the phone remote
-- Admins in AMA ID Cards or Black Belt Prep can always do everything. Someone with only TV ticks can't open
-- AMA ID Cards or Black Belt Prep.
do $$
begin
  if to_regclass('public.tv_permissions') is null then
    create table public.tv_permissions (
      email      text not null,
      permission text not null,
      created_at timestamptz not null default now(),
      primary key (email, permission)
    );
    -- First run: everyone who could edit the TV before keeps it
    if to_regclass('public.staff_permissions') is not null then
      execute $q$ insert into public.tv_permissions (email, permission)
        select distinct lower(email), 'edit' from public.staff_permissions where permission <> 'printer' on conflict do nothing $q$;
    end if;
    if to_regclass('public.prep_roles') is not null then
      execute $q$ insert into public.tv_permissions (email, permission)
        select distinct lower(email), 'edit' from public.prep_roles on conflict do nothing $q$;
    end if;
  end if;
end $$;

alter table public.tv_permissions drop constraint if exists tv_permissions_permission_check;
alter table public.tv_permissions add constraint tv_permissions_permission_check check (permission in ('edit', 'slides', 'screens', 'party', 'remote'));

-- Can the signed-in person do this on the TV? ('edit' or 'remote'; edit includes the remote; 'admin' = an admin in either app)
create or replace function public.tv_can(p_perm text) returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare me text := lower(auth.jwt() ->> 'email'); yes boolean := false;
begin
  if me is null then return false; end if;
  if to_regclass('public.staff_permissions') is not null then
    execute 'select exists (select 1 from public.staff_permissions where email = $1 and permission = ''admin'')' into yes using me;
    if yes then return true; end if;
  end if;
  if to_regclass('public.prep_roles') is not null then
    execute 'select exists (select 1 from public.prep_roles where email = $1 and role = ''admin'')' into yes using me;
    if yes then return true; end if;
  end if;
  if p_perm = 'admin' then return false; end if;   -- only the apps' admins manage TV permissions
  return exists (select 1 from public.tv_permissions where email = me and (permission = p_perm or permission = 'edit'));
end $$;
grant execute on function public.tv_can(text) to authenticated;
create or replace function public.tv_is_staff() returns boolean   -- can use the TV editor (slides or screens)
  language sql stable security definer set search_path = public as $$ select public.tv_can('slides') or public.tv_can('screens') $$;
grant execute on function public.tv_is_staff() to authenticated;

alter table public.tv_permissions enable row level security;
drop policy if exists "see own tv permissions" on public.tv_permissions;
drop policy if exists "admins manage tv permissions" on public.tv_permissions;
create policy "see own tv permissions" on public.tv_permissions for select to authenticated
  using (email = lower(auth.jwt() ->> 'email') or public.tv_can('admin'));
create policy "admins manage tv permissions" on public.tv_permissions for all to authenticated
  using (public.tv_can('admin')) with check (public.tv_can('admin'));

-- ---------- Settings ----------
create table if not exists public.tv_settings (
  id          int primary key default 1 check (id = 1),
  screen_code text not null default upper(substr(md5(random()::text), 1, 6)),
  seconds     int not null default 10 check (seconds between 3 and 600),
  show_clock  boolean not null default true,
  show_logo   boolean not null default true,
  updated_at  timestamptz not null default now()
);
insert into public.tv_settings (id) values (1) on conflict (id) do nothing;
-- Displays: 1 = the dojang TV, 2 = the tablets (upright). Each has its own slides, screen code, party mode and settings;
-- the events calendar and poster templates are shared.
alter table public.tv_settings add column if not exists display text not null default 'tv';
alter table public.tv_settings drop constraint if exists tv_settings_id_check;
alter table public.tv_settings add constraint tv_settings_id_check check (id in (1, 2));
alter table public.tv_settings drop constraint if exists tv_settings_display_check;
alter table public.tv_settings add constraint tv_settings_display_check check ((id = 1 and display = 'tv') or (id = 2 and display = 'tablet'));
insert into public.tv_settings (id, display) values (2, 'tablet') on conflict (id) do nothing;
create unique index if not exists tv_settings_code_idx on public.tv_settings (screen_code);
alter table public.tv_settings add column if not exists banner text;
-- Sign-in mode (for the tablets): show this page (e.g. the ESC sign-in) until nobody has touched it for signin_idle
-- seconds, then the slideshow; a tap brings it back (not during a party or a blackout)
alter table public.tv_settings add column if not exists signin_url text;
alter table public.tv_settings add column if not exists signin_idle int not null default 60;
-- 'page': a tap goes to the sign-in page itself (for sites that can't be shown inside another page, like ESC; a kiosk
-- app such as Fully Kiosk brings the slides back when idle). 'frame': shown inside the display, which comes back by itself.
alter table public.tv_settings add column if not exists signin_open text not null default 'page';
alter table public.tv_settings drop constraint if exists tv_settings_signin_open_check;
alter table public.tv_settings add constraint tv_settings_signin_open_check check (signin_open in ('page', 'frame', 'kiosk'));
-- 'kiosk': FreeKiosk shows the sign-in page, with our slides as its screensaver. During a party (or blackout) the page
-- asks FreeKiosk's REST API on the tablet (port below, optional key) to put the party on the main screen, so taps don't
-- leave it; afterwards it goes back to the sign-in page.
alter table public.tv_settings add column if not exists kiosk_port int not null default 8080;
-- Low battery: a red bar along the top of the screen below this % (when not charging); 0 = off
alter table public.tv_settings add column if not exists battery_warn int not null default 20;
-- During a party, a big QR code along the bottom (e.g. the participation waiver), with a line of text. Tablets.
alter table public.tv_settings add column if not exists party_qr_url text;
alter table public.tv_settings add column if not exists party_qr_text text;
alter table public.tv_settings drop constraint if exists tv_settings_party_qr_check;
alter table public.tv_settings add constraint tv_settings_party_qr_check check (party_qr_url is null or (party_qr_url ~* '^https?://\S+$' and length(party_qr_url) <= 1000));
alter table public.tv_settings drop constraint if exists tv_settings_battery_check;
alter table public.tv_settings add constraint tv_settings_battery_check check (battery_warn between 0 and 100);
alter table public.tv_settings add column if not exists kiosk_key text;
alter table public.tv_settings drop constraint if exists tv_settings_kiosk_port_check;
alter table public.tv_settings add constraint tv_settings_kiosk_port_check check (kiosk_port between 1 and 65535);
alter table public.tv_settings drop constraint if exists tv_settings_signin_check;
alter table public.tv_settings add constraint tv_settings_signin_check check (signin_idle between 10 and 900 and (signin_url is null or signin_url = '' or signin_url ~* '^https://'));   -- a message along the bottom, e.g. "Tap to sign in" ('' = none)
update public.tv_settings set banner = case when id = 2 then 'Tap to sign in' else '' end where banner is null;
alter table public.tv_settings add column if not exists shuffle boolean not null default false;   -- play the slides in a random order
alter table public.tv_settings add column if not exists only_slide uuid;          -- party mode: the one slide to show
alter table public.tv_settings add column if not exists only_until timestamptz;   -- ... until this time
alter table public.tv_settings add column if not exists reload_at timestamptz;    -- "Refresh the TV" was pressed at this time
alter table public.tv_settings add column if not exists quiet_on boolean not null default false;   -- quiet hours: no slideshow at night
alter table public.tv_settings add column if not exists quiet_from time not null default '21:00';
alter table public.tv_settings add column if not exists quiet_to time not null default '07:00';
alter table public.tv_settings add column if not exists quiet_style text not null default 'logo';
-- Each day's slideshow hours, e.g. {"1": {"on": "15:00", "off": "21:00"}, "0": null} (0 = Sunday ... 6 = Saturday; null = closed all day).
-- Outside them the TV is quiet. Empty: the same quiet_from/quiet_to every day.
alter table public.tv_settings add column if not exists quiet_days jsonb;
-- Scheduled screen-off times on top of the slideshow hours, e.g. Saturday 10:00 for 5 minutes:
-- [{"days": [6], "at": "10:00", "minutes": 5, "for": "all" | "loc:sydenham" | "dev:<screen id>"}]
alter table public.tv_settings add column if not exists offs jsonb not null default '[]'::jsonb;
alter table public.tv_settings drop constraint if exists tv_settings_quiet_check;
alter table public.tv_settings add constraint tv_settings_quiet_check check (quiet_style in ('black', 'logo'));
alter table public.tv_settings add column if not exists blackout boolean not null default false;     -- "Black out the screen": black until turned back on
alter table public.tv_settings add column if not exists remote_until timestamptz;               -- phone remote: the TV listens closely until then
alter table public.tv_settings add column if not exists remote_seq bigint not null default 0;     -- ... numbers each button press
alter table public.tv_settings add column if not exists remote_cmd jsonb;                         -- ... the last press, e.g. {"cmd": "next"}
alter table public.tv_settings add column if not exists remote_at timestamptz;
alter table public.tv_settings add column if not exists blackout_at timestamptz;   -- when the blackout started (filled in by itself)
alter table public.tv_settings add column if not exists only_at timestamptz;       -- when this party mode started (filled in by itself)
alter table public.tv_settings drop constraint if exists tv_settings_code_check;
alter table public.tv_settings add constraint tv_settings_code_check check (screen_code ~ '^[A-Z0-9]{4,12}$');

-- ---------- Slides ----------
create table if not exists public.tv_slides (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  title       text,
  body        text,
  media_path  text,                 -- file in the "tv" storage bucket (photos, videos, info slide backgrounds)
  theme       text not null default 'green',
  live_kind   text check (live_kind in ('next_grading', 'events', 'month', 'birthdays')),
  seconds     int check (seconds is null or seconds between 3 and 600),   -- blank = the default
  position    int not null,         -- filled in automatically: new slides go at the end
  enabled     boolean not null default true,
  starts_on   date,
  ends_on     date,
  created_by  text,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (kind <> 'live' or live_kind is not null),
  check (kind not in ('photo', 'video') or media_path is not null),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index if not exists tv_slides_position_idx on public.tv_slides (position);
alter table public.tv_slides drop constraint if exists tv_slides_theme_check;
alter table public.tv_slides add constraint tv_slides_theme_check check (theme in ('green', 'dark', 'gold', 'light', 'party'));
alter table public.tv_slides add column if not exists party boolean not null default false;   -- made for party mode
alter table public.tv_slides add column if not exists event_on date;                           -- countdown: the day it counts to
alter table public.tv_slides add column if not exists count_to text;                           -- countdown: 'date' or 'grading'
alter table public.tv_slides drop constraint if exists tv_slides_kind_check;
alter table public.tv_slides add constraint tv_slides_kind_check check (kind in ('photo', 'video', 'text', 'live', 'countdown', 'qr'));
alter table public.tv_slides add column if not exists link text;   -- QR code slides: the link the code opens
alter table public.tv_slides add column if not exists display text not null default 'tv';   -- which display it's on: 'tv' or 'tablet'
-- A party slide's partner on the other screen (the TV poster and its tablet version), so they go on and off together
alter table public.tv_slides add column if not exists linked uuid references public.tv_slides (id) on delete set null;
-- Times of day: only shows between show_from and show_to (either can be blank; to before from = overnight), on show_days (0 = Sunday ... 6; blank = every day)
alter table public.tv_slides add column if not exists show_from time;
alter table public.tv_slides add column if not exists show_to time;
alter table public.tv_slides add column if not exists show_days int[];
alter table public.tv_slides drop constraint if exists tv_slides_display_check;
alter table public.tv_slides add constraint tv_slides_display_check check (display in ('tv', 'tablet'));
alter table public.tv_slides drop constraint if exists tv_slides_qr_check;
alter table public.tv_slides add constraint tv_slides_qr_check check (kind <> 'qr' or (link ~* '^https?://' and media_path is not null));
alter table public.tv_slides drop constraint if exists tv_slides_countdown_check;
delete from public.tv_slides where kind = 'live' and live_kind in ('congrats', 'sessions');   -- these slides were removed
alter table public.tv_slides drop constraint if exists tv_slides_live_kind_check;
alter table public.tv_slides add constraint tv_slides_live_kind_check check (live_kind in ('next_grading', 'events', 'month', 'birthdays'));
alter table public.tv_slides add constraint tv_slides_countdown_check check (kind <> 'countdown' or count_to = 'grading' or (count_to = 'date' and event_on is not null));

-- ---------- Booked parties ----------
create table if not exists public.tv_party_bookings (
  id          uuid primary key default gen_random_uuid(),
  slide_id    uuid not null references public.tv_slides on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null check (ends_at > starts_at),
  created_by  text default lower(auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tv_party_bookings_time_idx on public.tv_party_bookings (starts_at);
alter table public.tv_party_bookings enable row level security;
drop policy if exists "staff edit party bookings" on public.tv_party_bookings;
create policy "staff edit party bookings" on public.tv_party_bookings for all to authenticated using (public.tv_can('party')) with check (public.tv_can('party'));

-- ---------- Locations ----------
-- Each device (a TV or tablet) can be at a location; slides and parties can be for one or more locations
-- (empty = every location). A device with no location shows only what's for every location.
do $$
begin
  if to_regclass('public.tv_locations') is null then
    create table public.tv_locations (
      slug       text primary key check (slug ~ '^[a-z0-9-]{2,30}$'),   -- used in device links (&loc=sydenham)
      name       text not null check (length(trim(name)) > 0),
      position   int not null default 0,
      created_at timestamptz not null default now()
    );
    insert into public.tv_locations (slug, name, position) values
      ('marrickville', 'Marrickville', 1), ('sydenham', 'Sydenham', 2), ('concord', 'Concord', 3), ('auburn', 'Auburn', 4), ('sylvania', 'Sylvania', 5);
  end if;
end $$;
-- A location's own slideshow hours (same shape as tv_settings.quiet_days), for every TV and tablet there.
-- Empty: each screen's main slideshow hours.
alter table public.tv_locations add column if not exists hours jsonb;
alter table public.tv_locations enable row level security;
drop policy if exists "staff see locations" on public.tv_locations;
drop policy if exists "staff edit locations" on public.tv_locations;
create policy "staff see locations" on public.tv_locations for select to authenticated using (public.tv_can('remote') or public.tv_can('party'));
create policy "staff edit locations" on public.tv_locations for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
alter table public.tv_slides add column if not exists locations text[];   -- which locations it shows at (empty = all)

-- ---------- TV status ----------
create table if not exists public.tv_screens (
  screen_id   text primary key,          -- made up by each TV the first time it starts
  last_seen   timestamptz not null default now(),
  started_at  timestamptz,               -- when its page last loaded
  showing     text,                      -- what's on screen now
  details     jsonb not null default '{}'::jsonb
);
alter table public.tv_screens add column if not exists loaded_at timestamptz;
alter table public.tv_screens add column if not exists display text not null default 'tv';   -- the TV or a tablet
alter table public.tv_screens add column if not exists name text;
alter table public.tv_screens add column if not exists blackout boolean not null default false;   -- just this device blacked out
alter table public.tv_screens add column if not exists location text references public.tv_locations (slug) on update cascade on delete set null;                              -- e.g. "Front desk", given in the editor
alter table public.tv_screens add column if not exists first_seen timestamptz not null default now();
alter table public.tv_screens add column if not exists blackout_at timestamptz;     -- when this device was blacked out
-- Each page load on the device and when it first checked in (FreeKiosk tablets run two pages, its main page and its
-- screensaver, with the same device id), so "Refresh" reaches every page: {"<page started>": "<server time>", ...}
alter table public.tv_screens add column if not exists loads jsonb not null default '{}'::jsonb;
-- "Back to normal" on just this device (staff code typed on it, or the editor): parties and blackouts that had
-- started by override_at are skipped on this device only, until override_until. Ones that start later still show.
alter table public.tv_screens add column if not exists override_at timestamptz;
alter table public.tv_screens add column if not exists override_until timestamptz;   -- server time of the first check-in after the page loaded
alter table public.tv_screens enable row level security;
drop policy if exists "staff see screens" on public.tv_screens;
drop policy if exists "staff remove screens" on public.tv_screens;
create policy "staff see screens" on public.tv_screens for select to authenticated using (public.tv_can('remote'));
create policy "staff remove screens" on public.tv_screens for delete to authenticated using (public.tv_is_staff());
drop policy if exists "staff name screens" on public.tv_screens;
create policy "staff name screens" on public.tv_screens for update to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
alter table public.tv_slides alter column position drop default;

create or replace function public.tv_stamp() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := lower(auth.jwt() ->> 'email');
    if new.position is null then select coalesce(max(position), 0) + 1 into new.position from public.tv_slides; end if;
  end if;
  new.updated_by := lower(auth.jwt() ->> 'email');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists tv_stamp on public.tv_slides;
create trigger tv_stamp before insert or update on public.tv_slides for each row execute function public.tv_stamp();
create or replace function public.tv_settings_stamp() returns trigger language plpgsql as $$
begin
  if new.remote_seq is distinct from old.remote_seq then return new; end if;   -- a remote button press isn't a change to the slideshow
  -- Party mode only: can start and stop a party, nothing else in the settings
  if auth.jwt() ->> 'email' is not null and not public.tv_is_staff()
     and (to_jsonb(new) - 'only_slide' - 'only_until' - 'updated_at') <> (to_jsonb(old) - 'only_slide' - 'only_until' - 'updated_at') then
    raise exception 'Your login can only start and stop party mode' using errcode = '42501';
  end if;
  new.updated_at := now(); new.screen_code := upper(new.screen_code);
  if new.reload_at is distinct from old.reload_at and new.reload_at is not null then new.reload_at := now(); end if;   -- server time, so TV clocks don't matter
  return new;
end $$;
drop trigger if exists tv_settings_stamp on public.tv_settings;
create trigger tv_settings_stamp before update on public.tv_settings for each row execute function public.tv_settings_stamp();
-- When a blackout or party mode starts (a device's "back to normal" only skips ones that had already started)
create or replace function public.tv_takeover_stamp() returns trigger language plpgsql as $$
begin
  if new.blackout and not coalesce(old.blackout, false) then new.blackout_at := now(); end if;
  if new.only_slide is not null and new.only_slide is distinct from old.only_slide then new.only_at := now(); end if;
  return new;
end $$;
drop trigger if exists tv_takeover_stamp on public.tv_settings;
create trigger tv_takeover_stamp before update on public.tv_settings for each row execute function public.tv_takeover_stamp();

alter table public.tv_settings enable row level security;
alter table public.tv_slides   enable row level security;
drop policy if exists "staff edit tv settings" on public.tv_settings;
drop policy if exists "staff edit tv slides" on public.tv_slides;
create policy "staff edit tv settings" on public.tv_settings for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
drop policy if exists "party mode settings" on public.tv_settings;
create policy "party mode settings" on public.tv_settings for all to authenticated using (public.tv_can('party')) with check (public.tv_can('party'));
create policy "staff edit tv slides"   on public.tv_slides   for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
drop policy if exists "remote sees tv slides" on public.tv_slides;
create policy "remote sees tv slides" on public.tv_slides for select to authenticated using (public.tv_can('remote') or public.tv_can('party'));
drop policy if exists "party slides" on public.tv_slides;
create policy "party slides" on public.tv_slides for all to authenticated using (party and public.tv_can('party')) with check (party and public.tv_can('party'));

-- ---------- Birthday poster templates ----------
-- A design with the name area left empty, plus where the name goes and how it looks (see tv/poster.js).
-- Staff type a name in the editor; the poster is drawn there and shown with party mode.
create table if not exists public.tv_poster_templates (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) > 0),
  image_path  text not null,          -- in the "tv" storage bucket
  settings    jsonb not null,
  position    int not null default 0,
  created_by  text default lower(auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.tv_poster_templates add column if not exists tablet_image_path text;   -- the upright version for the tablets (optional)
alter table public.tv_poster_templates add column if not exists tablet_settings jsonb;      -- ... and where the name goes on it (with w, h)
alter table public.tv_poster_templates enable row level security;
drop policy if exists "staff edit poster templates" on public.tv_poster_templates;
create policy "staff edit poster templates" on public.tv_poster_templates for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
drop policy if exists "party sees poster templates" on public.tv_poster_templates;
create policy "party sees poster templates" on public.tv_poster_templates for select to authenticated using (public.tv_can('party'));

-- ---------- Events calendar (the "Events this month" live slide) ----------
create table if not exists public.tv_events (
  id          uuid primary key default gen_random_uuid(),
  starts_on   date not null,
  ends_on     date check (ends_on is null or ends_on >= starts_on),   -- empty: a one-day event
  title       text not null check (length(trim(title)) > 0),
  note        text,                                                    -- e.g. "1:30 pm, Marrickville"
  created_by  text default lower(auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tv_events_dates_idx on public.tv_events (starts_on);
create table if not exists public.tv_months (       -- e.g. October: "Month of Health & Nutrition"
  month       date primary key check (extract(day from month) = 1),
  theme       text not null check (length(trim(theme)) > 0)
);
alter table public.tv_events enable row level security;
alter table public.tv_months enable row level security;
drop policy if exists "staff edit events" on public.tv_events;
drop policy if exists "staff edit months" on public.tv_months;
create policy "staff edit events" on public.tv_events for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());
create policy "staff edit months" on public.tv_months for all to authenticated using (public.tv_is_staff()) with check (public.tv_is_staff());

-- ---------- What the TV gets (no sign-in, screen code only) ----------
drop function if exists public.tv_feed(text);
drop function if exists public.tv_feed(text, text, text);
-- The whole feed. tv_feed (below) sends it only when it has changed since the screen's last copy.
create or replace function public.tv_feed_full(p_code text, p_screen text default null, p_loc text default null) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare
  s public.tv_settings%rowtype;
  loc text;   -- this device's location (set in the editor, or from its link)
  dev_dark boolean := false;   -- this device blacked out on its own
  today date := (now() at time zone 'Australia/Sydney')::date;
  slides jsonb; live jsonb := '{}'::jsonb; v jsonb; changed timestamptz; one_slide jsonb;
  one_id uuid; one_until timestamptz; one_changed timestamptz;
  m0 date := date_trunc('month', (now() at time zone 'Australia/Sydney'))::date;   -- this month
  m1 date := (date_trunc('month', (now() at time zone 'Australia/Sydney')) + interval '1 month')::date;   -- next month
  two boolean;
  now_time time := (now() at time zone 'Australia/Sydney')::time;
  day_hours jsonb;
  hours jsonb; hours_on boolean;
  off_now boolean := false;
  dev_dark_at timestamptz; ov_at timestamptz; ov_until timestamptz;
  ov boolean := false;        -- this device was put back to normal
  skipped boolean := false;   -- ... and it's skipping a party or blackout now
  has_code boolean := to_regclass('public.tv_staff_code') is not null and exists (select 1 from public.tv_staff_code where code_hash is not null);
  dow int := extract(dow from (now() at time zone 'Australia/Sydney'))::int;
begin
  select * into s from public.tv_settings where screen_code = upper(trim(coalesce(p_code, '')));   -- the code says which display
  if not found then
    return jsonb_build_object('error', 'wrong_code');
  end if;
  select sc.location, coalesce(sc.blackout, false), sc.blackout_at, sc.override_at, sc.override_until into loc, dev_dark, dev_dark_at, ov_at, ov_until
    from public.tv_screens sc where sc.screen_id = p_screen;
  ov := coalesce(ov_until > now() and ov_at is not null, false);
  -- Back to normal on this device: blackouts that had started by then don't count here
  if ov and s.blackout and coalesce(s.blackout_at, '-infinity') <= ov_at then s.blackout := false; skipped := true; end if;
  if ov and dev_dark and coalesce(dev_dark_at, '-infinity') <= ov_at then dev_dark := false; skipped := true; end if;
  if loc is null then select l.slug into loc from public.tv_locations l where l.slug = lower(trim(coalesce(p_loc, ''))); end if;

  -- Blacked out from the remote or the editor (the whole screen, or just this device): black, whatever else is on
  if s.blackout or dev_dark then
    return jsonb_build_object(
      'settings', jsonb_build_object('seconds', s.seconds, 'show_clock', false, 'show_logo', false, 'signin', nullif(trim(coalesce(s.signin_url, '')), ''), 'signin_idle', s.signin_idle, 'signin_open', s.signin_open,
        'kiosk_port', s.kiosk_port, 'kiosk_key', nullif(s.kiosk_key, ''), 'battery_warn', s.battery_warn, 'shuffle', s.shuffle),
      'version', s.updated_at, 'slides', '[]'::jsonb, 'live', '{}'::jsonb, 'today', today,
      'quiet', 'black', 'blackout', true, 'override_ok', has_code, 'remote', coalesce(s.remote_until > now(), false), 'display', s.display);
  end if;

  -- Party mode: just the one slide, until the set time. Started now in the editor, or booked ahead.
  -- Only parties for this device's location (or for every location) count.
  -- Back to normal on this device skips parties that had started by then.
  if s.only_slide is not null and s.only_until > now()
     and exists (select 1 from public.tv_slides os where os.id = s.only_slide and (coalesce(cardinality(os.locations), 0) = 0 or loc = any(os.locations))) then
    if ov and coalesce(s.only_at, '-infinity') <= ov_at then skipped := true;
    else one_id := s.only_slide; one_until := s.only_until; one_changed := s.updated_at; end if;
  end if;
  if one_id is null then
    select b.slide_id, b.ends_at, b.updated_at into one_id, one_until, one_changed
      from public.tv_party_bookings b join public.tv_slides bs on bs.id = b.slide_id
     where b.starts_at <= now() and b.ends_at > now() and bs.display = s.display
       and (coalesce(cardinality(bs.locations), 0) = 0 or loc = any(bs.locations))
       and not (ov and b.starts_at <= ov_at)
     order by (coalesce(cardinality(bs.locations), 0) = 0), b.starts_at desc limit 1;   -- a party for this location wins over one for everywhere
    if one_id is null and ov and exists (select 1 from public.tv_party_bookings b join public.tv_slides bs on bs.id = b.slide_id
         where b.starts_at <= now() and b.ends_at > now() and bs.display = s.display and b.starts_at <= ov_at
           and (coalesce(cardinality(bs.locations), 0) = 0 or loc = any(bs.locations))) then skipped := true; end if;
  end if;
  if one_id is not null then
    select jsonb_build_object('id', t.id, 'kind', t.kind, 'title', t.title, 'body', t.body, 'media_path', t.media_path,
             'theme', t.theme, 'live_kind', t.live_kind, 'seconds', t.seconds)
      into one_slide from public.tv_slides t where t.id = one_id;
  end if;
  if one_slide is not null then
    return jsonb_build_object(
      'settings', jsonb_build_object('seconds', s.seconds, 'show_clock', false, 'show_logo', false, 'signin', nullif(trim(coalesce(s.signin_url, '')), ''), 'signin_idle', s.signin_idle, 'signin_open', s.signin_open,
        'kiosk_port', s.kiosk_port, 'kiosk_key', nullif(s.kiosk_key, ''), 'battery_warn', s.battery_warn,
        'party_qr', nullif(trim(coalesce(s.party_qr_url, '')), ''), 'party_qr_text', nullif(trim(coalesce(s.party_qr_text, '')), '')),
      'version', greatest(s.updated_at, one_changed), 'slides', jsonb_build_array(one_slide), 'live', '{}'::jsonb, 'today', today,
      'only', true, 'only_until', one_until, 'override_ok', has_code, 'remote', coalesce(s.remote_until > now(), false), 'display', s.display);
  end if;

  -- Scheduled screen-off times for this device (or its location, or every device)
  off_now := exists (
    select 1 from jsonb_array_elements(coalesce(s.offs, '[]'::jsonb)) e,
           lateral (select (e ->> 'at')::time a, (e ->> 'at')::time + make_interval(mins => greatest(1, least(720, coalesce((e ->> 'minutes')::int, 0)))) z) w
     where jsonb_typeof(e -> 'days') = 'array' and (e -> 'days') @> to_jsonb(extract(dow from (now() at time zone 'Australia/Sydney'))::int)
       and (coalesce(e ->> 'for', 'all') = 'all' or e ->> 'for' = 'loc:' || coalesce(loc, '') or e ->> 'for' = 'dev:' || coalesce(p_screen, ''))
       and (case when w.z > w.a then now_time >= w.a and now_time < w.z else now_time >= w.a or now_time < w.z end));

  -- Quiet hours (a party still shows): a black screen or just the logo outside each day's slideshow hours.
  -- A location with its own hours uses those instead of the screen's main ones.
  select l.hours into hours from public.tv_locations l where l.slug = loc;
  hours_on := hours is not null or s.quiet_on;
  hours := coalesce(hours, s.quiet_days);
  day_hours := hours -> extract(dow from (now() at time zone 'Australia/Sydney'))::int::text;
  if off_now or hours_on and (case
       when hours is not null then
         day_hours is null or jsonb_typeof(day_hours) <> 'object'
         or not (now_time >= (day_hours ->> 'on')::time and now_time < (day_hours ->> 'off')::time)
       else s.quiet_from <> s.quiet_to and (case when s.quiet_from < s.quiet_to
         then now_time >= s.quiet_from and now_time < s.quiet_to
         else now_time >= s.quiet_from or now_time < s.quiet_to end) end) then
    return jsonb_build_object(
      'settings', jsonb_build_object('seconds', s.seconds, 'show_clock', false, 'show_logo', false, 'signin', nullif(trim(coalesce(s.signin_url, '')), ''), 'signin_idle', s.signin_idle, 'signin_open', s.signin_open,
        'kiosk_port', s.kiosk_port, 'kiosk_key', nullif(s.kiosk_key, ''), 'battery_warn', s.battery_warn, 'shuffle', s.shuffle),
      'version', s.updated_at, 'slides', '[]'::jsonb, 'live', '{}'::jsonb, 'today', today,
      'quiet', s.quiet_style, 'off', off_now, 'remote', coalesce(s.remote_until > now(), false), 'display', s.display);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'kind', t.kind, 'title', t.title, 'body', t.body, 'media_path', t.media_path,
           'theme', t.theme, 'live_kind', t.live_kind, 'seconds', t.seconds, 'event_on', t.event_on, 'count_to', t.count_to, 'link', t.link) order by t.position, t.created_at), '[]'::jsonb),
         max(t.updated_at)
    into slides, changed
    from public.tv_slides t
   where t.enabled and not t.party and t.display = s.display
     and (coalesce(cardinality(t.locations), 0) = 0 or loc = any(t.locations)) and (t.starts_on is null or t.starts_on <= today) and (t.ends_on is null or t.ends_on >= today)
     and not (t.kind = 'countdown' and t.count_to = 'date' and t.event_on < today)
     -- times of day and days of the week
     and (t.show_days is null or cardinality(t.show_days) = 0 or dow = any(t.show_days))
     and (case when t.show_from is null and t.show_to is null then true
               when t.show_to is null then now_time >= t.show_from
               when t.show_from is null then now_time < t.show_to
               when t.show_from < t.show_to then now_time >= t.show_from and now_time < t.show_to
               when t.show_from > t.show_to then now_time >= t.show_from or now_time < t.show_to
               else true end);

  -- Events: what's left of this month; in the last 10 days of the month (or once this month is over), next month too
  two := today >= m1 - 10 or not exists (select 1 from public.tv_events e where coalesce(e.ends_on, e.starts_on) >= today and e.starts_on < m1);
  select coalesce(jsonb_agg(jsonb_build_object('month', q.mm, 'theme', (select mt.theme from public.tv_months mt where mt.month = q.mm), 'events', (
           select coalesce(jsonb_agg(jsonb_build_object('start', e.starts_on, 'end', e.ends_on, 'title', e.title, 'note', e.note) order by e.starts_on, e.ends_on nulls first, e.title), '[]'::jsonb)
             from public.tv_events e
            where coalesce(e.ends_on, e.starts_on) >= today
              and greatest(date_trunc('month', e.starts_on)::date, m0) = q.mm)) order by q.mm), '[]'::jsonb)
    into v from (select m0 mm union all select m1 where two) q;
  live := live || jsonb_build_object('events', v);
  select jsonb_build_object('month', mt.month, 'theme', mt.theme) into v from public.tv_months mt where mt.month = m0;
  live := live || jsonb_build_object('month', v);

  -- Birthdays today: current members (status Enrolled) whose date of birth is today (Sydney).
  -- First name + last initial only, no date or age. Only sent if efc_members is set up in this project.
  if to_regclass('public.efc_members') is not null then
    execute $q$
      select coalesce(jsonb_agg(nm order by lower(nm)), '[]'::jsonb) from (
        select distinct trim(
                 coalesce(nullif(btrim(first_name), ''), split_part(btrim(full_name), ' ', 1))
                 || case when coalesce(nullif(btrim(last_name), ''), nullif(split_part(btrim(full_name), ' ', 2), '')) <> ''
                         then ' ' || left(coalesce(nullif(btrim(last_name), ''), split_part(btrim(full_name), ' ', 2)), 1) || '.'
                         else '' end) nm
          from public.efc_members
         where status ilike 'enrolled'
           and coalesce(btrim(full_name), '') <> ''
           and date_of_birth ~ '^\d{4}-\d{2}-\d{2}'
           and to_char(left(date_of_birth, 10)::date, 'MM-DD') = to_char($1::date, 'MM-DD')
      ) q $q$ into v using today;
    live := live || jsonb_build_object('birthdays', v);
  end if;

  -- Live AMA info (only if Black Belt Prep is set up in this project)
  if to_regclass('public.prep_cycles') is not null then
    execute $q$
      select jsonb_build_object('cycle', c.name, 'date', c.grading_date)
        from public.prep_cycles c
       where c.status = 'active' and c.grading_date >= $1
       order by c.grading_date limit 1 $q$ into v using today;
    live := live || jsonb_build_object('next_grading', v);

  end if;

  return jsonb_build_object(
    'settings', jsonb_build_object('seconds', s.seconds, 'show_clock', s.show_clock, 'show_logo', s.show_logo, 'banner', nullif(trim(coalesce(s.banner, '')), ''),
      'signin', nullif(trim(coalesce(s.signin_url, '')), ''), 'signin_idle', s.signin_idle, 'signin_open', s.signin_open,
        'kiosk_port', s.kiosk_port, 'kiosk_key', nullif(s.kiosk_key, ''), 'battery_warn', s.battery_warn, 'shuffle', s.shuffle),
    'remote', coalesce(s.remote_until > now(), false), 'display', s.display, 'location', loc, 'override', skipped,
    'version', greatest(coalesce(changed, s.updated_at), s.updated_at),
    'slides', slides, 'live', live, 'today', today);
end $$;
revoke all on function public.tv_feed_full(text, text, text) from public, anon, authenticated;

-- What the screen asks for every 20 seconds. p_have is the fingerprint of the copy it already has: when nothing
-- has changed it gets back just {"same": true}, a few bytes instead of the whole slideshow (saves Supabase egress).
create or replace function public.tv_feed(p_code text, p_screen text default null, p_loc text default null, p_have text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f jsonb; h text;
begin
  f := public.tv_feed_full(p_code, p_screen, p_loc);
  if f ? 'error' then return f; end if;
  h := md5(f::text);
  if p_have is not null and p_have = h then return jsonb_build_object('same', true, 'hash', h); end if;
  return f || jsonb_build_object('hash', h);
end $$;
grant execute on function public.tv_feed(text, text, text, text) to anon, authenticated;

-- The TV checks in: records what it's showing, and hears whether it should reload
drop function if exists public.tv_checkin(text, text, text, timestamptz, jsonb);
create or replace function public.tv_checkin(p_code text, p_screen text, p_showing text, p_started timestamptz, p_details jsonb default '{}'::jsonb, p_loc text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare s public.tv_settings%rowtype; loaded timestamptz; link_loc text; lds jsonb; k text := coalesce(p_started::text, '');
begin
  select * into s from public.tv_settings where screen_code = upper(trim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('error', 'wrong_code'); end if;
  if coalesce(p_screen, '') !~ '^[A-Za-z0-9_-]{6,40}$' then return jsonb_build_object('error', 'bad_screen'); end if;
  -- The server's time when this page load first checked in (TV clocks can be wrong). Kept per page load, so the two
  -- pages of a FreeKiosk tablet don't keep resetting each other's (which stopped "Refresh" reaching them).
  select coalesce(t.loads, '{}'::jsonb) into lds from public.tv_screens t where t.screen_id = p_screen;
  lds := coalesce(lds, '{}'::jsonb);
  loaded := (lds ->> k)::timestamptz;
  if loaded is null then
    loaded := now(); lds := lds || jsonb_build_object(k, loaded);
    if (select count(*) from jsonb_object_keys(lds)) > 6 then   -- just the newest few
      select jsonb_object_agg(e.key, e.value) into lds from (select key, value from jsonb_each(lds) order by (value #>> '{}')::timestamptz desc limit 6) e;
    end if;
  end if;
  select l.slug into link_loc from public.tv_locations l where l.slug = lower(trim(coalesce(p_loc, '')));   -- a link with &loc=
  insert into public.tv_screens as t (screen_id, display, location, last_seen, started_at, loaded_at, showing, details, loads)
    values (p_screen, s.display, link_loc, now(), p_started, loaded, left(p_showing, 200), coalesce(p_details, '{}'::jsonb), lds)
  on conflict (screen_id) do update set display = excluded.display, location = coalesce(t.location, excluded.location), last_seen = now(), started_at = excluded.started_at,
    loaded_at = excluded.loaded_at, showing = excluded.showing, details = excluded.details, loads = excluded.loads;
  delete from public.tv_screens where last_seen < now() - interval '30 days';   -- forget old TVs
  return jsonb_build_object('reload', s.reload_at is not null and s.reload_at > loaded);
end $$;
grant execute on function public.tv_checkin(text, text, text, timestamptz, jsonb, text) to anon, authenticated;

-- ---------- Phone remote ----------
-- The phone sends a button press; while the remote is open (10 minutes since its last use) the TV checks every
-- second or two, carries out the newest press, and reports what's on screen.
drop function if exists public.tv_remote_send(text, uuid);
create or replace function public.tv_remote_send(p_cmd text, p_slide uuid default null, p_display text default 'tv')
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare n bigint; dark boolean;
begin
  if not public.tv_can('remote') then raise exception 'Your login doesn''t have the TV remote ticked' using errcode = '42501'; end if;
  if p_cmd not in ('hello', 'next', 'back', 'pause', 'play', 'show', 'done', 'blackout', 'wake') then raise exception 'Unknown button'; end if;
  update public.tv_settings set
      blackout = case p_cmd when 'blackout' then true when 'wake' then false else blackout end,
      remote_seq = remote_seq + 1, remote_at = now(),
      remote_cmd = jsonb_build_object('cmd', p_cmd, 'slide', p_slide),
      remote_until = case when p_cmd = 'done' then now() + interval '30 seconds' else now() + interval '10 minutes' end
   where display = coalesce(p_display, 'tv') returning remote_seq, blackout into n, dark;
  if n is null then raise exception 'Unknown display'; end if;
  return jsonb_build_object('seq', n, 'blackout', dark);
end $$;
revoke all on function public.tv_remote_send(text, uuid, text) from public, anon;
grant execute on function public.tv_remote_send(text, uuid, text) to authenticated;

create or replace function public.tv_remote_poll(p_code text, p_screen text, p_after bigint, p_state jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare s public.tv_settings%rowtype;
begin
  select * into s from public.tv_settings where screen_code = upper(trim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('error', 'wrong_code'); end if;
  if coalesce(p_screen, '') ~ '^[A-Za-z0-9_-]{6,40}$' then   -- what's on screen, for the remote and TV status
    update public.tv_screens set last_seen = now(), showing = left(coalesce(p_state ->> 'showing', showing), 200),
           details = details || (coalesce(p_state, '{}'::jsonb) - 'showing') || jsonb_build_object('remote_seq', p_after)
     where screen_id = p_screen;
  end if;
  return jsonb_build_object('on', coalesce(s.remote_until > now(), false), 'seq', s.remote_seq,
    'cmd', case when p_after is not null and s.remote_seq > p_after and s.remote_at > now() - interval '30 seconds' then s.remote_cmd end);
end $$;
grant execute on function public.tv_remote_poll(text, text, bigint, jsonb) to anon, authenticated;

-- Black out (or turn back on) one device. Devices with the remote open hear about it straight away.
create or replace function public.tv_screen_blackout(p_screen text, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d text;
begin
  if not public.tv_can('remote') then raise exception 'Your login doesn''t have TV access' using errcode = '42501'; end if;
  update public.tv_screens set blackout = coalesce(p_on, false), blackout_at = case when p_on then now() end where screen_id = p_screen returning display into d;
  if d is null then raise exception 'That device isn''t here any more'; end if;
  update public.tv_settings set remote_seq = remote_seq + 1, remote_at = now(), remote_cmd = jsonb_build_object('cmd', 'refresh') where display = d;
  return jsonb_build_object('blackout', coalesce(p_on, false));
end $$;
revoke all on function public.tv_screen_blackout(text, boolean) from public, anon;
grant execute on function public.tv_screen_blackout(text, boolean) to authenticated;

-- ---------- Back to normal on one device ----------
-- During a party or blackout, staff can put one device back to normal (on a tablet: the sign-in page) while the
-- others carry on: in the editor (that device's button), or on the device itself by holding its top-left corner
-- and typing the staff code. The code is stored hashed; nobody can read it back. 10 wrong tries in 15 minutes
-- locks it for 15 minutes on every device.
create table if not exists public.tv_staff_code (
  id          int primary key default 1 check (id = 1),
  code_hash   text,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  fails       int not null default 0,
  fails_since timestamptz,
  locked_until timestamptz
);
insert into public.tv_staff_code (id) values (1) on conflict (id) do nothing;
alter table public.tv_staff_code enable row level security;   -- no policies: only the functions below use it
revoke all on public.tv_staff_code from anon, authenticated;

create or replace function public.tv_staff_code_info()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r public.tv_staff_code%rowtype;
begin
  if not public.tv_can('remote') then return null; end if;
  select * into r from public.tv_staff_code where id = 1;
  return jsonb_build_object('set', r.code_hash is not null, 'updated_at', r.updated_at, 'updated_by', r.updated_by);
end $$;
revoke all on function public.tv_staff_code_info() from public, anon;
grant execute on function public.tv_staff_code_info() to authenticated;

create or replace function public.tv_staff_code_set(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare c text := nullif(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'), '');
begin
  if not public.tv_is_staff() then raise exception 'Your login can''t change the TV settings' using errcode = '42501'; end if;
  if c is not null and c !~ '^[0-9]{4,8}$' then raise exception 'The staff code needs 4 to 8 digits'; end if;
  update public.tv_staff_code set code_hash = case when c is null then null else extensions.crypt(c, extensions.gen_salt('bf')) end,
         updated_at = now(), updated_by = lower(auth.jwt() ->> 'email'), fails = 0, fails_since = null, locked_until = null where id = 1;
  return public.tv_staff_code_info();
end $$;
revoke all on function public.tv_staff_code_set(text) from public, anon;
grant execute on function public.tv_staff_code_set(text) to authenticated;

-- The device sends the code typed on it. Right: just this device skips the party or blackout on now (for up to 12 hours).
create or replace function public.tv_override(p_code text, p_screen text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare s public.tv_settings%rowtype; r public.tv_staff_code%rowtype;
begin
  select * into s from public.tv_settings where screen_code = upper(trim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('error', 'wrong_code'); end if;
  if not exists (select 1 from public.tv_screens where screen_id = p_screen) then return jsonb_build_object('error', 'unknown_screen'); end if;
  select * into r from public.tv_staff_code where id = 1 for update;
  if r.code_hash is null then return jsonb_build_object('error', 'no_code'); end if;
  if r.locked_until > now() then return jsonb_build_object('error', 'locked', 'until', r.locked_until); end if;
  if extensions.crypt(coalesce(p_pin, ''), r.code_hash) <> r.code_hash then
    if r.fails_since is null or r.fails_since < now() - interval '15 minutes' then r.fails := 0; r.fails_since := now(); end if;
    r.fails := r.fails + 1;
    update public.tv_staff_code set fails = case when r.fails >= 10 then 0 else r.fails end, fails_since = case when r.fails >= 10 then null else r.fails_since end,
           locked_until = case when r.fails >= 10 then now() + interval '15 minutes' else locked_until end where id = 1;
    return jsonb_build_object('error', case when r.fails >= 10 then 'locked' else 'wrong' end);
  end if;
  update public.tv_staff_code set fails = 0, fails_since = null where id = 1;
  update public.tv_screens set override_at = now(), override_until = now() + interval '12 hours', blackout = false where screen_id = p_screen;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.tv_override(text, text, text) to anon, authenticated;

-- The editor's button for one device: back to normal now (p_on), or let it show the party or blackout again
create or replace function public.tv_screen_normal(p_screen text, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare d text;
begin
  if not public.tv_can('remote') then raise exception 'Your login doesn''t have TV access' using errcode = '42501'; end if;
  update public.tv_screens set override_at = case when p_on then now() end, override_until = case when p_on then now() + interval '12 hours' end,
         blackout = case when p_on then false else blackout end
   where screen_id = p_screen returning display into d;
  if d is null then raise exception 'That device isn''t here any more'; end if;
  update public.tv_settings set remote_seq = remote_seq + 1, remote_at = now(), remote_cmd = jsonb_build_object('cmd', 'refresh') where display = d;
  return jsonb_build_object('normal', coalesce(p_on, false));
end $$;
revoke all on function public.tv_screen_normal(text, boolean) from public, anon;
grant execute on function public.tv_screen_normal(text, boolean) to authenticated;

-- ---------- Photos and videos ----------
-- Files are public by link (the TV shows them without signing in); names are random, and only staff can add,
-- change or remove them. 50 MB per file (Supabase's limit on the free plan).
insert into storage.buckets (id, name, public) values ('tv', 'tv', true) on conflict (id) do update set public = true;
drop policy if exists "tv files add"    on storage.objects;
drop policy if exists "tv files change" on storage.objects;
drop policy if exists "tv files remove" on storage.objects;
drop policy if exists "tv files list"   on storage.objects;
create policy "tv files add"    on storage.objects for insert to authenticated with check (bucket_id = 'tv' and (public.tv_is_staff() or (public.tv_can('party') and name like 'photos/%')));
create policy "tv files change" on storage.objects for update to authenticated using (bucket_id = 'tv' and public.tv_is_staff());
create policy "tv files remove" on storage.objects for delete to authenticated using (bucket_id = 'tv' and public.tv_is_staff());
create policy "tv files list"   on storage.objects for select to authenticated using (bucket_id = 'tv' and public.tv_is_staff());
