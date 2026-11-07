-- Black Belt Prep: update 12 (readiness reason: needs more time at their current belt)
-- Run once in Supabase > SQL Editor, after prep-update-11.sql. Safe to run again.

alter table public.prep_readiness drop constraint if exists prep_readiness_reason_check;
alter table public.prep_readiness add constraint prep_readiness_reason_check
  check (reason in ('technique', 'fitness', 'attendance', 'more_practice', 'more_time', 'instructor_recommendation', 'other'));

-- The "not ready yet" text reads better with the new reasons (only if it still has the original wording)
update public.prep_message_templates
   set body = 'Hi! {first_name} is working hard towards {belt}. Before grading, our instructors would like to see {reason}, and we will help get there. Keep up the great training! - AMA Marrickville',
       updated_at = now()
 where kind = 'not_ready'
   and body = 'Hi! {first_name} is working hard towards {belt}. Our instructors would like a little more time on {reason} before grading, and we will help get there. Keep up the great training! - AMA Marrickville';
