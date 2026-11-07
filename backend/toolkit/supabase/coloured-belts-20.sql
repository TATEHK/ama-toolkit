-- Coloured belts / gradings: update 20 (an EFC session per belt on a day)
-- Run once in Supabase > SQL Editor. Safe to run again.
--
-- EFC runs a separate session for each belt transition (White->Yellow, Yellow->Orange, ...), so a grading day
-- that covers several belts needs one EFC session ID per belt. efc_belt_sessions maps the belt a student is on
-- now (e.g. "Red Two Belt") -> that belt's EFC session ID. A student books into the session for their own belt;
-- a belt with no entry falls back to the day's single efc_session_id. Black belt (bb) days are unchanged: those
-- route per school through efc_sessions.

alter table public.cb_days add column if not exists efc_belt_sessions jsonb not null default '{}'::jsonb;
