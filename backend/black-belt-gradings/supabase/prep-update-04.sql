-- Black Belt Prep: update 04
-- Run once in Supabase > SQL Editor, after prep-update-03.sql. Safe to run again.
-- Grading fees: separate from session fees, set per belt being graded to, charged only to students
-- who are grading, and due 3 weeks before the cycle's grading date.

-- Belts in grading order; a grading moves a student to the next one
create or replace function public.prep_next_belt(belt text) returns text
  language sql immutable as $$
  select (array['Cho Dan Bo','Probationary Black Belt','1st Dan Black Belt','1st Dan Level 1',
                '2nd Dan','2nd Dan Level 1','2nd Dan Level 2',
                '3rd Dan','3rd Dan Level 1','3rd Dan Level 2','3rd Dan Level 3',
                '4th Dan','4th Dan Level 1','4th Dan Level 2','4th Dan Level 3','4th Dan Level 4','5th Dan'])
         [array_position(array['Cho Dan Bo','Probationary Black Belt','1st Dan Black Belt','1st Dan Level 1',
                '2nd Dan','2nd Dan Level 1','2nd Dan Level 2',
                '3rd Dan','3rd Dan Level 1','3rd Dan Level 2','3rd Dan Level 3',
                '4th Dan','4th Dan Level 1','4th Dan Level 2','4th Dan Level 3','4th Dan Level 4','5th Dan'], belt) + 1]
$$;
grant execute on function public.prep_next_belt(text) to authenticated;

-- Grading fee for each belt being graded to
create table if not exists public.prep_grading_fee_rates (
  target_rank text primary key,
  fee         numeric(10,2) not null check (fee >= 0),
  updated_at  timestamptz not null default now()
);

-- Who is grading in each cycle
alter table public.prep_enrolments add column if not exists is_grading boolean not null default false;

-- Fee records now have a kind: session fees or the grading fee (each student can have one of each per cycle)
alter table public.prep_payments
  add column if not exists kind text not null default 'sessions' check (kind in ('sessions','grading')),
  add column if not exists target_rank text;
alter table public.prep_payments drop constraint if exists prep_payments_student_id_cycle_id_key;
create unique index if not exists prep_payments_one_per_kind on public.prep_payments (student_id, cycle_id, kind);

-- Work out what a student owes
create or replace function public.prep_payment_amount() returns trigger
  language plpgsql security definer set search_path = public as $$
declare c public.prep_cycles%rowtype; present int; rate numeric;
begin
  if new.fee_override is not null and length(trim(coalesce(new.override_reason, new.notes, ''))) = 0 then
    raise exception 'Give a reason (in the notes) for a one-off fee.';
  end if;
  if new.kind = 'grading' then
    select fee into rate from public.prep_grading_fee_rates where target_rank = new.target_rank;
    new.payment_plan := null;
    new.amount_due := coalesce(new.fee_override, rate, 0);
    new.updated_at := now();
    return new;
  end if;
  if new.payment_plan is null then
    select default_payment_plan into new.payment_plan from public.prep_settings where id = 1;
  end if;
  select * into c from public.prep_cycles where cycle_id = new.cycle_id;
  select count(*) into present from public.prep_attendance
    where cycle_id = new.cycle_id and student_id = new.student_id and status = 'present';
  new.amount_due := coalesce(new.fee_override,
    case new.payment_plan when 'per_session' then coalesce(c.per_session_fee, 0) * present else coalesce(c.upfront_fee, c.session_fee, 0) end);
  new.updated_at := now();
  return new;
end $$;

-- Mark a student as grading (or not). Grading creates their grading fee, due 3 weeks before the grading date.
-- Un-marking removes the fee, unless a payment has been recorded against it.
create or replace function public.prep_set_grading(p_cycle uuid, p_student text, p_grading boolean)
returns void language plpgsql security definer set search_path = public as $$
declare c public.prep_cycles%rowtype; s public.prep_students%rowtype; target text;
begin
  if not public.prep_has_role('grading') then raise exception 'You do not have permission to choose who is grading.'; end if;
  select * into c from public.prep_cycles where cycle_id = p_cycle;
  select * into s from public.prep_students where student_id = p_student;
  if not exists (select 1 from public.prep_enrolments where cycle_id = p_cycle and student_id = p_student) then
    raise exception 'That student is not in this cycle.';
  end if;
  if p_grading then
    target := public.prep_next_belt(s.belt_rank);
    if target is null then raise exception '% has no next belt to grade to. Set their belt rank first.', s.full_name; end if;
    update public.prep_enrolments set is_grading = true where cycle_id = p_cycle and student_id = p_student;
    insert into public.prep_payments (student_id, cycle_id, kind, target_rank, invoiced_at, due_date)
      values (p_student, p_cycle, 'grading', target, now(), c.grading_date - 21)
      on conflict (student_id, cycle_id, kind) do update set target_rank = excluded.target_rank, due_date = excluded.due_date;
  else
    if exists (select 1 from public.prep_payment_transactions t join public.prep_payments p using (payment_id)
               where p.cycle_id = p_cycle and p.student_id = p_student and p.kind = 'grading') then
      raise exception '% has a grading fee payment recorded, so they cannot be taken off the grading list. Record a refund first.', s.full_name;
    end if;
    delete from public.prep_payments where cycle_id = p_cycle and student_id = p_student and kind = 'grading';
    update public.prep_enrolments set is_grading = false where cycle_id = p_cycle and student_id = p_student;
  end if;
end $$;
grant execute on function public.prep_set_grading(uuid, text, boolean) to authenticated;

-- Grading date changes move the grading fee due date (3 weeks before)
create or replace function public.prep_cycle_grading_date_changed() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.grading_date is distinct from old.grading_date then
    update public.prep_payments set due_date = new.grading_date - 21 where cycle_id = new.cycle_id and kind = 'grading';
  end if;
  return new;
end $$;
drop trigger if exists prep_cycle_grading_date_changed on public.prep_cycles;
create trigger prep_cycle_grading_date_changed after update on public.prep_cycles
  for each row execute function public.prep_cycle_grading_date_changed();

-- Changing a grading fee updates students charged it (one-off fees are left alone)
create or replace function public.prep_grading_rate_changed() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  update public.prep_payments set updated_at = now()
    where kind = 'grading' and target_rank = coalesce(new.target_rank, old.target_rank);
  return coalesce(new, old);
end $$;
drop trigger if exists prep_grading_rate_changed on public.prep_grading_fee_rates;
create trigger prep_grading_rate_changed after insert or update or delete on public.prep_grading_fee_rates
  for each row execute function public.prep_grading_rate_changed();

-- Session tools only deal with session fees
create or replace function public.prep_session_fees(p_cycle uuid default null)
returns table (cycle_id uuid, student_id text, payment_plan text, paid_sessions uuid[])
  language sql stable security definer set search_path = public as $$
  select p.cycle_id, p.student_id, p.payment_plan,
         coalesce((select array_agg(x.session_id) from (
                     select t.session_id from public.prep_payment_transactions t
                     where t.payment_id = p.payment_id and t.session_id is not null
                     group by t.session_id
                     having sum(case t.type when 'refund' then -t.amount else t.amount end) > 0) x), '{}')
  from public.prep_payments p
  where p.kind = 'sessions' and (p_cycle is null or p.cycle_id = p_cycle)
    and public.prep_has_role('instructor', 'attendance', 'payments')
$$;

create or replace function public.prep_record_session_payment(p_session uuid, p_student text, p_paid boolean, p_method text default 'cash')
returns boolean language plpgsql security definer set search_path = public as $$
declare se public.prep_sessions%rowtype; c public.prep_cycles%rowtype; pay public.prep_payments%rowtype; net numeric;
begin
  if not public.prep_has_role('instructor', 'attendance', 'payments') then
    raise exception 'You do not have permission to record session payments.';
  end if;
  select * into se from public.prep_sessions where session_id = p_session;
  if not found then raise exception 'Session not found.'; end if;
  select * into c from public.prep_cycles where cycle_id = se.cycle_id;
  select * into pay from public.prep_payments where cycle_id = se.cycle_id and student_id = p_student and kind = 'sessions';
  if not found then raise exception 'That student is not in this cycle.'; end if;
  select coalesce(sum(case type when 'refund' then -amount else amount end), 0) into net
    from public.prep_payment_transactions where payment_id = pay.payment_id and session_id = p_session;
  if p_paid and net <= 0 then
    insert into public.prep_payment_transactions (payment_id, type, amount, paid_on, method, notes, session_id)
      values (pay.payment_id, 'payment', coalesce(c.per_session_fee, 0), coalesce(se.session_date, current_date),
              coalesce(p_method, 'cash'), 'Paid at session ' || se.session_number, p_session);
  elsif not p_paid and net > 0 then
    insert into public.prep_payment_transactions (payment_id, type, amount, notes, session_id)
      values (pay.payment_id, 'correction', -net, 'Session ' || se.session_number || ' payment undone', p_session);
  end if;
  return p_paid;
end $$;

create or replace function public.prep_attendance_fee() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    update public.prep_payments set updated_at = now()
      where cycle_id = new.cycle_id and student_id = new.student_id and kind = 'sessions' and payment_plan = 'per_session';
  end if;
  return new;
end $$;

-- Payment summary: adds the kind of fee and the belt being graded to
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
       coalesce(p.due_date, case when p.kind = 'sessions' then c.payment_due_date end) as due_date,
       coalesce(p.status_override,
         case
           when coalesce(t.refunded, 0) > 0 and coalesce(t.paid, 0) <= 0 then 'refunded'
           when (p.payment_plan = 'per_session' or p.kind = 'grading') and p.amount_due = 0 and coalesce(t.paid, 0) = 0 then 'not_invoiced'
           when p.amount_due > 0 and coalesce(t.paid, 0) >= p.amount_due then 'paid'
           when p.amount_due = 0 and p.invoiced_at is not null then 'paid'
           when p.invoiced_at is null then 'not_invoiced'
           when coalesce(p.due_date, case when p.kind = 'sessions' then c.payment_due_date end) < current_date then 'overdue'
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

-- Overview: session fee as before, plus whether they are grading and their grading fee
create or replace view public.prep_overview with (security_invoker = true) as
select e.cycle_id, c.name as cycle_name, c.status as cycle_status,
       st.student_id, st.full_name, st.club, st.belt_rank, st.is_active, st.is_test,
       a.attended, a.absences, a.excused, a.unrecorded, a.sessions, a.attendance_pct, a.attendance_eligible,
       r.status as readiness, r.reason as readiness_reason, r.next_action, r.reviewed_at,
       ps.status as payment_status, ps.amount_due, ps.amount_paid, ps.balance,
       g.grading_id, g.status as grading_status, g.eligibility_decision, g.result as grading_result,
       cert.status as certificate_status,
       idc.status as id_card_status,
       e.is_grading,
       case when e.is_grading then coalesce(gf.target_rank, public.prep_next_belt(st.belt_rank)) end as grading_to,
       gf.status as grading_fee_status, gf.amount_due as grading_fee_due, gf.amount_paid as grading_fee_paid,
       gf.balance as grading_fee_balance, gf.due_date as grading_fee_due_date
from public.prep_enrolments e
join public.prep_cycles c on c.cycle_id = e.cycle_id
join public.prep_students st on st.student_id = e.student_id
left join public.prep_attendance_summary a on a.cycle_id = e.cycle_id and a.student_id = e.student_id
left join public.prep_readiness r on r.cycle_id = e.cycle_id and r.student_id = e.student_id
left join public.prep_payment_summary ps on ps.cycle_id = e.cycle_id and ps.student_id = e.student_id and ps.kind = 'sessions'
left join public.prep_payment_summary gf on gf.cycle_id = e.cycle_id and gf.student_id = e.student_id and gf.kind = 'grading'
left join lateral (select * from public.prep_grading g where g.cycle_id = e.cycle_id and g.student_id = e.student_id
                   order by g.created_at desc limit 1) g on true
left join lateral (select * from public.prep_certificates x where x.grading_id = g.grading_id
                   order by x.created_at desc limit 1) cert on true
left join public.prep_id_card_status idc on idc.student_id = e.student_id;

-- Security: everyone with a prep role can see the grading fee list; admins set it
alter table public.prep_grading_fee_rates enable row level security;
drop policy if exists "read" on public.prep_grading_fee_rates;
drop policy if exists "write" on public.prep_grading_fee_rates;
create policy "read"  on public.prep_grading_fee_rates for select to authenticated using (public.prep_can_view());
create policy "write" on public.prep_grading_fee_rates for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));

drop trigger if exists prep_grading_fee_rates_audit on public.prep_grading_fee_rates;
create trigger prep_grading_fee_rates_audit after insert or update or delete on public.prep_grading_fee_rates
  for each row execute function public.prep_audit('target_rank');
