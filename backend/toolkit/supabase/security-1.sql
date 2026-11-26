-- Security pass (Nov 2026), applied:
-- 1. Server-only tables had no row level security and were readable/writable with the public key.
alter table public.cb_subscription enable row level security;
alter table public.dinner_config  enable row level security;
alter table public.dinner_rsvp    enable row level security;
revoke all on public.cb_subscription, public.dinner_config, public.dinner_rsvp from anon, authenticated;
-- 2. cb_students (a security definer view with names, phones, emails, DOB) was readable by ANY signed-in login.
--    Now: a signed-in login needs some Coloured Belts permission. Service role and security definer functions
--    (current_user is not 'authenticated') are unaffected. Applied by wrapping the existing definition:
--    create or replace view public.cb_students with (security_barrier = true) as
--      select s.* from (<previous definition>) s
--      where current_user <> 'authenticated'
--         or exists (select 1 from public.app_permissions p where p.email = lower(auth.jwt() ->> 'email') and p.app = 'cb');

-- 3. Passkeys skip the hub's mobile+PIN check. hub_still_active() (authenticated): a login linked to a hub mobile
--    (hub_logins) must be Active on ama_os.staff (matched on the last 9 digits of the phone); logins with no hub
--    link are unaffected; a stale staff list (no sync for 3 days) locks nobody out. hub-signin.js calls it right
--    after a passkey sign-in and hourly while signed in by passkey, and signs out if it says no.
--    (Applied as migration hub_still_active_check; see the live definition.)
