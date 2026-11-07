-- Black Belt Prep: update 07 (session fees have no due date; belts up to 9th Dan)
-- Run once in Supabase > SQL Editor, after prep-update-06.sql. Safe to run again.
-- Session fees are paid at each session (or upfront when the student chooses), so they no longer have a
-- due date and are never shown as overdue: while owing they show as "Payment due". Grading fees keep their
-- due date (3 weeks before the grading date) and still become overdue after it.

-- The "Fees are due as soon as a student joins" setting has been removed from the app; fees are always due on joining
update public.prep_settings set invoice_on_enrol = true where id = 1;
update public.prep_payments set invoiced_at = coalesce(invoiced_at, now()) where kind = 'sessions';

create or replace view public.prep_payment_summary with (security_invoker = true) as
with t as (
  select payment_id,
         coalesce(sum(case type when 'refund' then -amount else amount end), 0) as paid,
         coalesce(sum(amount) filter (where type = 'refund'), 0) as refunded,
         count(*)::int as transactions,
         max(paid_on) as last_paid_on
  from public.prep_payment_transactions group by payment_id
)
select p.payment_id, p.student_id, p.cycle_id, p.amount_due,
       coalesce(t.paid, 0) as amount_paid,
       p.amount_due - coalesce(t.paid, 0) as balance,
       coalesce(t.transactions, 0) as transactions,
       t.last_paid_on,
       p.due_date as due_date,
       coalesce(p.status_override,
         case
           when coalesce(t.refunded, 0) > 0 and coalesce(t.paid, 0) <= 0 then 'refunded'
           when (p.payment_plan = 'per_session' or p.kind = 'grading') and p.amount_due = 0 and coalesce(t.paid, 0) = 0 then 'not_invoiced'
           when p.amount_due > 0 and coalesce(t.paid, 0) >= p.amount_due then 'paid'
           when p.amount_due = 0 and p.invoiced_at is not null then 'paid'
           when p.invoiced_at is null then 'not_invoiced'
           when p.due_date < current_date then 'overdue'
           when coalesce(t.paid, 0) > 0 then 'partially_paid'
           else 'due'
         end) as status,
       p.status_override is not null as status_overridden,
       p.override_reason, p.notes,
       p.payment_plan, p.fee_override,
       p.kind, p.target_rank
from public.prep_payments p
join public.prep_cycles c on c.cycle_id = p.cycle_id
left join t on t.payment_id = p.payment_id;


-- ============================================================================
-- Belts up to 9th Dan: 5th Dan Levels 1 to 5, then 6th, 7th, 8th and 9th Dan.
-- 5th Dan Level 5 goes for 6th Dan; 6th, 7th and 8th Dan go straight for the next Dan.
-- Each of 6th to 9th Dan has its own Dan numbers (set the next number in Settings).
-- ============================================================================
create or replace function public.prep_dan_target(belt text) returns text
  language sql immutable as $$
  select case belt
    when 'Cho Dan Bo'              then 'Probationary Black Belt'
    when 'Probationary Black Belt' then '1st Dan Black Belt'
    when '1st Dan Level 1'         then '2nd Dan'
    when '2nd Dan Level 2'         then '3rd Dan'
    when '3rd Dan Level 3'         then '4th Dan'
    when '4th Dan Level 4'         then '5th Dan'
    when '5th Dan Level 5'         then '6th Dan'
    when '6th Dan'                 then '7th Dan'
    when '7th Dan'                 then '8th Dan'
    when '8th Dan'                 then '9th Dan'
  end
$$;

create or replace function public.prep_next_belt(belt text) returns text
  language sql immutable as $$
  select (array['Cho Dan Bo','Probationary Black Belt','1st Dan Black Belt','1st Dan Level 1',
                '2nd Dan','2nd Dan Level 1','2nd Dan Level 2',
                '3rd Dan','3rd Dan Level 1','3rd Dan Level 2','3rd Dan Level 3',
                '4th Dan','4th Dan Level 1','4th Dan Level 2','4th Dan Level 3','4th Dan Level 4',
                '5th Dan','5th Dan Level 1','5th Dan Level 2','5th Dan Level 3','5th Dan Level 4','5th Dan Level 5',
                '6th Dan','7th Dan','8th Dan','9th Dan'])
         [array_position(array['Cho Dan Bo','Probationary Black Belt','1st Dan Black Belt','1st Dan Level 1',
                '2nd Dan','2nd Dan Level 1','2nd Dan Level 2',
                '3rd Dan','3rd Dan Level 1','3rd Dan Level 2','3rd Dan Level 3',
                '4th Dan','4th Dan Level 1','4th Dan Level 2','4th Dan Level 3','4th Dan Level 4',
                '5th Dan','5th Dan Level 1','5th Dan Level 2','5th Dan Level 3','5th Dan Level 4','5th Dan Level 5',
                '6th Dan','7th Dan','8th Dan','9th Dan'], belt) + 1]
$$;

alter table public.prep_dan_counters drop constraint if exists prep_dan_counters_target_rank_check;
alter table public.prep_dan_counters add constraint prep_dan_counters_target_rank_check check (target_rank in
  ('Probationary Black Belt','1st Dan Black Belt','2nd Dan','3rd Dan','4th Dan','5th Dan','6th Dan','7th Dan','8th Dan','9th Dan'));
