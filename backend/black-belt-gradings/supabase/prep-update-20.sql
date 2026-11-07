-- Black Belt Prep: update 20 — schedule the nurture sender (Supabase only: needs pg_cron, pg_net and Vault)
-- Run once in Supabase > SQL Editor, after deploying the "nurture" Edge Function. Safe to run again.
--
-- A job posts { action: "run" } to the nurture function every 15 minutes. The function only sends steps that are
-- due, and only for cycles with a started, un-paused run. The shared secret lives in Vault; the function checks it
-- with prep_nurture_cron_ok so the secret is never in the app or in git.

-- The secret check the Edge Function calls (service role only).
create or replace function public.prep_nurture_cron_ok(p_secret text)
returns boolean language sql security definer set search_path = public, vault as $$
  select coalesce(p_secret <> '' and p_secret = (select decrypted_secret from vault.decrypted_secrets where name = 'nurture_cron_secret' limit 1), false);
$$;
revoke all on function public.prep_nurture_cron_ok(text) from public, anon, authenticated;
do $$ begin if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.prep_nurture_cron_ok(text) to service_role; end if; end $$;

do $$
declare secret text;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
    -- make the shared secret once
    if not exists (select 1 from vault.secrets where name = 'nurture_cron_secret') then
      perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'nurture_cron_secret', 'Lets the scheduled job call the nurture function');
    end if;
    select decrypted_secret into secret from vault.decrypted_secrets where name = 'nurture_cron_secret' limit 1;
    -- every 15 minutes
    perform cron.unschedule('prep-nurture-send') where exists (select 1 from cron.job where jobname = 'prep-nurture-send');
    perform cron.schedule('prep-nurture-send', '*/15 * * * *', format($job$
      select net.http_post(
        url := 'https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/nurture',
        headers := jsonb_build_object('Content-Type','application/json','x-nurture-cron', %L),
        body := jsonb_build_object('action','run')
      );
    $job$, secret));
  else
    raise notice 'pg_cron / pg_net not available — schedule the nurture run another way, or enable them in Database > Extensions.';
  end if;
end $$;
