-- AMA Toolkit: coloured belt grading, update 33 (makeup grading days)
-- Run once in Supabase > SQL Editor, after coloured-belts-32.sql. Safe to run again.
--
-- A grading day can be marked as a "makeup" grading. The hub's "Can't make grading" view only lists
-- makeup days in its "move to a session" picker, so students who missed a grading are moved onto a
-- purpose-made makeup day rather than any grading day.

alter table public.cb_days add column if not exists makeup boolean not null default false;
