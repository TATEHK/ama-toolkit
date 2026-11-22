-- Every 2 minutes: ask the cb function to send any pending high-risk alerts (activity-log.sql, activity-log-cb.sql).
-- Uses the same Vault secret as the booking sequence (coloured-belts-23.sql). Sends nothing until there are recipients.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net')
     and exists (select 1 from pg_extension where extname = 'supabase_vault') then
    if not exists (select 1 from vault.secrets where name = 'cb_cron_secret') then
      perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'cb_cron_secret', 'Lets scheduled jobs call the cb function');
    end if;
    perform cron.unschedule('cb-alerts') where exists (select 1 from cron.job where jobname = 'cb-alerts');
    perform cron.schedule('cb-alerts', '*/2 * * * *', $job$
      select net.http_post(url := 'https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/cb',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cb-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'cb_cron_secret')),
        body := '{"action":"alerts_tick"}'::jsonb,
        timeout_milliseconds := 120000)
    $job$);
    -- The daily summary: fires hourly, but the cb function only sends at summary_hour (Sydney), once a day.
    perform cron.unschedule('cb-alerts-summary') where exists (select 1 from cron.job where jobname = 'cb-alerts-summary');
    perform cron.schedule('cb-alerts-summary', '3 * * * *', $job$
      select net.http_post(url := 'https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/cb',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cb-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'cb_cron_secret')),
        body := '{"action":"alerts_summary"}'::jsonb,
        timeout_milliseconds := 120000)
    $job$);
  end if;
end $$;
