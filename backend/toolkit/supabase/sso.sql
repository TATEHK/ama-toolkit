-- AMA Toolkit: cross-system auto-login ("SSO handoff") — database side.
-- Run once in Supabase > SQL Editor. Safe to run again.
-- Goes with the "sso" edge function (supabase/sso-function.ts) and the /sso/ landing page.
--
-- One table: used sign-in links, so a signed link cannot be replayed. Only the "sso" function (service role)
-- ever touches it; no access from the apps. Rows past their expiry are dead weight and are cleaned up nightly.

create table if not exists public.sso_used_jti (
  jti         text primary key,
  used_at     timestamptz not null default now(),
  expires_at  timestamptz not null
);
alter table public.sso_used_jti enable row level security;
revoke all on public.sso_used_jti from anon, authenticated;

-- Tidy up expired nonces (optional but keeps the table small). Needs pg_cron; ignore if not available.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('sso_used_jti_cleanup', '17 3 * * *',
      $q$ delete from public.sso_used_jti where expires_at < now() - interval '1 day' $q$);
  end if;
exception when others then null; end $$;
