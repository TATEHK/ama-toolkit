-- AMA ID Cards: phone notifications
-- Run once in Supabase > SQL Editor (after setup.sql). Safe to run again.
-- Then deploy the "notify" Edge Function (supabase/functions/notify/index.ts).

create extension if not exists pg_net with schema extensions;

-- Phones that turned on notifications in the app
create table if not exists public.push_subscriptions (
  endpoint        text primary key,
  user_email      text default (auth.jwt() ->> 'email'),
  p256dh          text not null,
  auth            text not null,
  wants_approvals boolean not null default true,
  wants_failures  boolean not null default true,
  created_at      timestamptz not null default now()
);
alter table public.push_subscriptions
  add column if not exists wants_printed boolean not null default true,
  add column if not exists wants_station boolean not null default true;
alter table public.push_subscriptions enable row level security;
drop policy if exists "own subscriptions" on public.push_subscriptions;
create policy "own subscriptions" on public.push_subscriptions for all to authenticated
  using (user_email = auth.jwt() ->> 'email')
  with check (user_email = auth.jwt() ->> 'email');

-- Private settings for sending. No policies, so only the Edge Function (service role) can read it.
create table if not exists public.push_config (
  id                int primary key default 1 check (id = 1),
  vapid_public      text,
  vapid_private_jwk jsonb,
  hook_secret       text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  function_url      text not null default 'https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/notify'
);
insert into public.push_config (id) values (1) on conflict (id) do nothing;
alter table public.push_config add column if not exists offline_notified boolean not null default false;
alter table public.push_config enable row level security;

-- The app reads the public key through this (the private key never leaves the database)
create or replace function public.vapid_public_key() returns text
  language sql security definer set search_path = public
  as $$ select vapid_public from public.push_config where id = 1 $$;
revoke all on function public.vapid_public_key() from public;
grant execute on function public.vapid_public_key() to authenticated;

-- Sends one notification through the Edge Function (only the database itself can call this)
create or replace function public.push_notify(kind text, payload jsonb) returns void
  language plpgsql security definer set search_path = public, extensions
as $$
declare cfg public.push_config%rowtype;
begin
  select * into cfg from public.push_config where id = 1;
  if cfg.function_url is null or not exists (select 1 from public.push_subscriptions) then return; end if;
  perform net.http_post(
    url     := cfg.function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', cfg.hook_secret),
    body    := jsonb_build_object('kind', kind, 'job', payload)
  );
end $$;
revoke all on function public.push_notify(text, jsonb) from public, anon, authenticated;

-- Print jobs: needs approval, failed, printed
create or replace function public.notify_print_job() returns trigger
  language plpgsql security definer set search_path = public, extensions
as $$
declare kind text;
begin
  if tg_op = 'INSERT' and new.status = 'pending' then kind := 'approval';
  elsif tg_op = 'UPDATE' and new.status = 'failed'  and old.status is distinct from 'failed'  then kind := 'failed';
  elsif tg_op = 'UPDATE' and new.status = 'printed' and old.status is distinct from 'printed' then kind := 'printed';
  else return new;
  end if;
  perform public.push_notify(kind, jsonb_build_object(
    'id', new.id, 'card_count', new.card_count, 'error', new.error, 'created_by_email', new.created_by_email));
  return new;
end $$;

drop trigger if exists print_jobs_notify on public.print_jobs;
create trigger print_jobs_notify
  after insert or update of status on public.print_jobs
  for each row execute function public.notify_print_job();

-- Printer offline: the print station stopped checking in while jobs are waiting
create or replace function public.check_print_station() returns void
  language plpgsql security definer set search_path = public, extensions
as $$
declare st public.print_station%rowtype; waiting int;
begin
  if (select offline_notified from public.push_config where id = 1) then return; end if;
  select * into st from public.print_station where id = 1;
  if st.last_seen is not null and st.last_seen > now() - interval '120 seconds' then return; end if;
  select count(*) into waiting from public.print_jobs where status in ('pending', 'approved');
  if waiting = 0 then return; end if;
  perform public.push_notify('offline', jsonb_build_object('count', waiting));
  update public.push_config set offline_notified = true where id = 1;
end $$;
revoke all on function public.check_print_station() from public, anon, authenticated;

-- Printer back online, or stopped on purpose (stop.bat)
create or replace function public.notify_station_change() returns trigger
  language plpgsql security definer set search_path = public, extensions
as $$
declare waiting int; flagged boolean;
begin
  if new.last_seen is null then
    if old.last_seen is not null then perform public.check_print_station(); end if;
    return new;
  end if;
  if new.last_seen < now() - interval '120 seconds' then return new; end if;
  if old.last_seen is not null and old.last_seen > now() - interval '120 seconds' then return new; end if;  -- was already online
  select offline_notified into flagged from public.push_config where id = 1;
  select count(*) into waiting from public.print_jobs where status in ('approved', 'printing');
  if flagged or waiting > 0 then
    perform public.push_notify('online', jsonb_build_object('count', waiting));
  end if;
  update public.push_config set offline_notified = false where id = 1 and offline_notified;
  return new;
end $$;

drop trigger if exists print_station_notify on public.print_station;
create trigger print_station_notify
  after update of last_seen on public.print_station
  for each row execute function public.notify_station_change();

-- Check every minute whether the printer has gone quiet
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('ama-printer-check', '* * * * *', 'select public.check_print_station()');
