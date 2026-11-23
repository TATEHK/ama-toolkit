-- coloured-belts-43: "grading started -> reply FINISHED" control by SMS.
--
-- When a coloured-belt grading day reaches its scheduled start_time, a job texts the configured number
-- ("Grading started at <school>. Reply FINISHED when it's done."). Replying FINISHED (handled by the existing
-- inbound-SMS 'reply' action in the cb function) marks that day closed, which kicks off the Black Belt Club
-- welcome flow (coloured-belts-40). If more than one grading is open, the reply asks which school.

-- When the "grading started" text was sent for a day (so it only goes once).
alter table public.cb_days add column if not exists started_prompt_at timestamptz;

-- Where the "grading started" text goes, and a switch to turn the whole thing off.
-- Kept separate from alert_phone (belt-correction alerts) so the two can differ.
alter table public.cb_settings add column if not exists grading_alert_phone text not null default '0483896150';
alter table public.cb_settings add column if not exists grading_alert_on    boolean not null default true;

-- ---------- Every 5 minutes: ask the "cb" function to text any grading that has just started ----------
-- Same Vault secret as the other scheduled jobs (coloured-belts-6/-23). The action is a cheap no-op when nothing is due.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net')
     and exists (select 1 from pg_extension where extname = 'supabase_vault') then
    if not exists (select 1 from vault.secrets where name = 'cb_cron_secret') then
      perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'cb_cron_secret', 'Lets scheduled jobs call the cb function');
    end if;
    perform cron.unschedule('cb-grading-started') where exists (select 1 from cron.job where jobname = 'cb-grading-started');
    perform cron.schedule('cb-grading-started', '*/5 * * * *', $job$
      select net.http_post(url := 'https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/cb',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cb-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'cb_cron_secret')),
        body := '{"action":"grading_started"}'::jsonb,
        timeout_milliseconds := 60000)
    $job$);
  end if;
end $$;
