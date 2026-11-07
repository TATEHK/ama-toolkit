-- Coloured belts / gradings: update 19 (an EFC session per school, for black belt and multi-school days)
-- Run once in Supabase > SQL Editor. Safe to run again.
--
-- Why: EFC only books a member into a session at their OWN school. A black belt grading gathers
-- candidates from several schools at one venue, so one grading day needs one EFC session per school.
-- efc_sessions maps school name -> EFC session ID. A member books into the session for their school;
-- a one-school coloured-belt day still just uses efc_session_id as before (efc_sessions stays empty).

alter table public.cb_days add column if not exists efc_sessions jsonb not null default '{}'::jsonb;
