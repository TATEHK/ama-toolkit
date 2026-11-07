-- Coloured belts / gradings: update 22 (a start time per belt/rank on a day)
-- Run once in Supabase > SQL Editor. Safe to run again.
--
-- A black belt grading runs in time blocks, and which block a candidate is in depends on the rank they grade to,
-- so one grading day has several start times. belt_times maps the belt/rank -> start time ("HH:MM"). For a black
-- belt day the key is the rank they grade to (belt_to); otherwise the belt they are on now (belt_from). A belt with
-- no entry falls back to the day's single start_time. Used for the time shown on booking links, confirmations and invites.

alter table public.cb_days add column if not exists belt_times jsonb not null default '{}'::jsonb;
