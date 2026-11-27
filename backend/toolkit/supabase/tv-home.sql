-- A tablet's own home page (TV editor > Tablets > Home page). Applied 2026-11-27 as migration tv_screen_home:
-- tv_screens.home_url / home_until; tv_checkin clears them once home_until has passed and returns {home, home_until}.
alter table public.tv_screens add column if not exists home_url text;
alter table public.tv_screens add column if not exists home_until timestamptz;
