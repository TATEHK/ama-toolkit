-- grading-event-3: the theory quiz becomes a private test. Each candidate works through it at their own pace on their
-- phone within one time limit, can change answers, then submits. No points or leaderboard; only staff see results.
--   ge_quiz.phase: closed | lobby (joining) | open (test running, q_started_at..q_ends_at) | ended
alter table public.ge_quiz drop constraint if exists ge_quiz_phase_check;
update public.ge_quiz set phase = 'closed' where phase not in ('closed', 'lobby');
alter table public.ge_quiz add constraint ge_quiz_phase_check check (phase in ('closed', 'lobby', 'open', 'ended'));
alter table public.ge_players add column if not exists submitted_at timestamptz;
