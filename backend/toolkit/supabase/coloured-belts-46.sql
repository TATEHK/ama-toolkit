-- coloured-belts-46: automatic morning-of reminder for black belt gradings.
--
-- The booking sequence skips black belt days, so they never got a morning reminder. The cb function's
-- grading_reminder action (called with no day) texts booked + paid, not-yet-graded families the "reminder"
-- text for every black belt grading happening today, from 8am Sydney. Dedup per entry means no one is
-- reminded twice. Scheduled at 21:00 and 22:00 UTC, which is 8am Sydney in AEDT and AEST; the off-hour run
-- is a no-op (the action's 8am gate + the dedup).
do $$
begin
  if exists (select 1 from pg_extension where extname='pg_cron') and exists (select 1 from pg_extension where extname='pg_net')
     and exists (select 1 from pg_extension where extname='supabase_vault') then
    -- retire the earlier one-off reminder (the daily job now covers that grading too)
    perform cron.unschedule('bb-reminder-15adf6f6') where exists (select 1 from cron.job where jobname='bb-reminder-15adf6f6');
    perform cron.unschedule('cb-bb-morning')        where exists (select 1 from cron.job where jobname='cb-bb-morning');
    perform cron.schedule('cb-bb-morning', '0 21,22 * * *', $job$
      select net.http_post(
        url := 'https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/cb',
        headers := jsonb_build_object('Content-Type','application/json','x-cb-cron',(select decrypted_secret from vault.decrypted_secrets where name='cb_cron_secret')),
        body := '{"action":"grading_reminder"}'::jsonb,
        timeout_milliseconds := 60000)
    $job$);
  end if;
end $$;
