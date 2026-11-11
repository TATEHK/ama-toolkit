-- AMA Toolkit: coloured belt grading, update 31 ("Can't make grading" list)
-- Run once in Supabase > SQL Editor, after coloured-belts-30.sql. Safe to run again.
--
-- A flag for the hub's "Can't make grading" tab. The cb reply handler sets it when a family can't
-- attend (replied "not grading", or declined the alternative dates they were offered); staff can
-- also set it by hand on an entry. It's cleared when the student is moved to a makeup grading day.

alter table public.cb_entries add column if not exists cant_make_at timestamptz;
alter table public.cb_entries add column if not exists cant_make_reason text;   -- 'not_grading' | 'declined_offer' | 'by_hand'
