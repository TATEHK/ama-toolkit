-- Coloured belts / gradings: update 21 (an EFC session per belt for each visiting school / venue)
-- Run once in Supabase > SQL Editor. Safe to run again.
--
-- A grading day can cover more than one school. Students from the day's own school book into efc_belt_sessions
-- (the per-belt session for that venue). Students from another school - and every candidate on a black belt day,
-- which runs the same grading at several venues - need the session for THEIR venue, which also differs by belt/rank.
-- efc_school_belt_sessions maps school/venue -> { belt_or_rank -> EFC session ID }. For coloured belts the inner
-- key is the belt the student is on now (e.g. "Red Two Belt"); for black belt days it is the rank they are grading
-- to (belt_to, e.g. "1st Dan Black Belt"). Falls back to the single per-school efc_sessions, then to book-by-hand.

alter table public.cb_days add column if not exists efc_school_belt_sessions jsonb not null default '{}'::jsonb;
