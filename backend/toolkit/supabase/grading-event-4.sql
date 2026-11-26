-- grading-event-4: the theory test pass mark is every question right. When a candidate submits with any wrong, they are
-- told only which questions to redo (never the answers) and redo just those until all are right or time runs out.
--   rounds       how many times they have submitted
--   first_score  correct on their first submission
--   redo         the question numbers (0-based) they are redoing now; null when none
alter table public.ge_players add column if not exists rounds integer not null default 0;
alter table public.ge_players add column if not exists first_score integer;
alter table public.ge_players add column if not exists redo jsonb;
