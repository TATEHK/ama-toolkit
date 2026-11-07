-- Black Belt Prep: update 01
-- Run once in Supabase > SQL Editor, after prep-setup.sql. Safe to run again.
-- Adds: Dan numbers, the final-session sign-off rule, and a grading date for each cycle.

-- ============================================================================
-- Dan numbers
-- ============================================================================
-- Students going for Probationary Black Belt or a Dan (they are on the belt before it) get a Dan number.
-- Set the starting number in the app under More > Settings; each student then gets the next number.
--   Cho Dan Bo               -> Probationary Black Belt
--   Probationary Black Belt  -> 1st Dan Black Belt
--   1st Dan Level 1          -> 2nd Dan
--   2nd Dan Level 2          -> 3rd Dan
--   3rd Dan Level 3          -> 4th Dan
--   4th Dan Level 4          -> 5th Dan
-- A student keeps their number if they repeat the same grading. Numbers are never reused.

alter table public.prep_settings add column if not exists next_dan_number int check (next_dan_number > 0);

create table if not exists public.prep_dan_numbers (
  dan_number  int primary key check (dan_number > 0),
  student_id  text not null references public.prep_students on delete restrict,
  target_rank text not null,
  cycle_id    uuid references public.prep_cycles on delete set null,
  assigned_at timestamptz not null default now(),
  assigned_by text,
  notes       text,
  unique (student_id, target_rank)
);

-- The rank a student is going for, when it needs a Dan number (otherwise null)
create or replace function public.prep_dan_target(belt text) returns text
  language sql immutable as $$
  select case belt
    when 'Cho Dan Bo'              then 'Probationary Black Belt'
    when 'Probationary Black Belt' then '1st Dan Black Belt'
    when '1st Dan Level 1'         then '2nd Dan'
    when '2nd Dan Level 2'         then '3rd Dan'
    when '3rd Dan Level 3'         then '4th Dan'
    when '4th Dan Level 4'         then '5th Dan'
  end
$$;
grant execute on function public.prep_dan_target(text) to authenticated;

-- Give one student their Dan number for their next rank (or return the one they already have).
-- Returns null when they are not going for a Dan, or no starting number has been set yet.
create or replace function public.prep_assign_dan_number(p_student text, p_cycle uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare target text; n int;
begin
  select public.prep_dan_target(belt_rank) into target from public.prep_students where student_id = p_student and is_active;
  if target is null then return null; end if;
  select dan_number into n from public.prep_dan_numbers where student_id = p_student and target_rank = target;
  if n is not null then return n; end if;
  loop
    update public.prep_settings set next_dan_number = next_dan_number + 1
      where id = 1 and next_dan_number is not null
      returning next_dan_number - 1 into n;
    if n is null then return null; end if;                       -- no starting number set
    exit when not exists (select 1 from public.prep_dan_numbers where dan_number = n);  -- skip numbers already used
  end loop;
  insert into public.prep_dan_numbers (dan_number, student_id, target_rank, cycle_id, assigned_by)
    values (n, p_student, target, p_cycle, public.prep_email());
  return n;
end $$;
revoke all on function public.prep_assign_dan_number(text, uuid) from public, anon, authenticated;

-- Everyone in a cycle who should have a Dan number but doesn't (e.g. numbering was set up later,
-- or a belt was corrected). Assigned in name order. Returns how many were given numbers.
create or replace function public.prep_assign_missing_dan_numbers(p_cycle uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not public.prep_has_role('admin') then raise exception 'Only an admin can assign Dan numbers.'; end if;
  if (select next_dan_number from public.prep_settings where id = 1) is null then
    raise exception 'Set the starting Dan number in Settings first.';
  end if;
  for r in
    select s.student_id from public.prep_enrolments e join public.prep_students s using (student_id)
    where e.cycle_id = p_cycle and s.is_active and public.prep_dan_target(s.belt_rank) is not null
      and not exists (select 1 from public.prep_dan_numbers d where d.student_id = s.student_id and d.target_rank = public.prep_dan_target(s.belt_rank))
    order by s.full_name, s.student_id
  loop
    perform public.prep_assign_dan_number(r.student_id, p_cycle);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function public.prep_assign_missing_dan_numbers(uuid) to authenticated;

-- Joining a cycle hands out the number
create or replace function public.prep_on_enrol_dan() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  perform public.prep_assign_dan_number(new.student_id, new.cycle_id);
  return new;
end $$;
drop trigger if exists prep_on_enrol_dan on public.prep_enrolments;
create trigger prep_on_enrol_dan after insert on public.prep_enrolments
  for each row execute function public.prep_on_enrol_dan();

-- Start New Preparation Cycle enrols students in name order, so Dan numbers follow the alphabet
create or replace function public.prep_start_new_cycle(
  p_name text, p_start date, p_end date, p_session_dates date[], p_fee numeric,
  p_payment_due date default null, p_student_ids text[] default null, p_notes text default null)
returns uuid language plpgsql set search_path = public as $$
declare cid uuid; i int;
begin
  if not public.prep_has_role('admin') then raise exception 'Only an admin can start a new cycle.'; end if;
  if exists (select 1 from public.prep_cycles where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A cycle called "%" already exists.', p_name;
  end if;
  insert into public.prep_cycles (name, start_date, end_date, session_fee, payment_due_date, notes)
    values (trim(p_name), p_start, p_end, coalesce(p_fee, (select default_session_fee from public.prep_settings)), p_payment_due, p_notes)
    returning cycle_id into cid;
  for i in 1 .. greatest(coalesce(array_length(p_session_dates, 1), 0), 4) loop
    insert into public.prep_sessions (cycle_id, session_number, session_date) values (cid, i, p_session_dates[i]);
  end loop;
  insert into public.prep_enrolments (cycle_id, student_id)
    select cid, s.student_id from public.prep_students s
    where s.is_active and (case when coalesce(cardinality(p_student_ids), 0) = 0 then not s.is_test
                                else s.student_id = any(p_student_ids) end)
    order by s.full_name, s.student_id
    on conflict do nothing;
  return cid;
end $$;

-- Security: everyone with a prep role can see Dan numbers; admins can correct them
alter table public.prep_dan_numbers enable row level security;
drop policy if exists "read" on public.prep_dan_numbers;
drop policy if exists "write" on public.prep_dan_numbers;
create policy "read"  on public.prep_dan_numbers for select to authenticated using (public.prep_can_view());
create policy "write" on public.prep_dan_numbers for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));

drop trigger if exists prep_dan_numbers_audit on public.prep_dan_numbers;
create trigger prep_dan_numbers_audit after insert or update or delete on public.prep_dan_numbers
  for each row execute function public.prep_audit('dan_number');

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'prep_dan_numbers') then
    alter publication supabase_realtime add table public.prep_dan_numbers;
  end if;
end $$;

-- ============================================================================
-- Grading date for each cycle (cycles are described by their session dates and grading date)
-- ============================================================================
alter table public.prep_cycles add column if not exists grading_date date;

-- ============================================================================
-- Sign-off: the final session of a cycle is the sign-off. A student only meets the attendance
-- requirement if they are marked Present at it (excused does not count).
-- ============================================================================
create or replace view public.prep_attendance_summary with (security_invoker = true) as
with last_session as (
  select cycle_id, max(session_number) as n from public.prep_sessions group by cycle_id
)
select e.cycle_id, e.student_id,
       count(*) filter (where a.status = 'present')      ::int as attended,
       count(*) filter (where a.status = 'absent')       ::int as absences,
       count(*) filter (where a.status = 'excused')      ::int as excused,
       count(*) filter (where a.status = 'not_recorded') ::int as unrecorded,
       count(a.attendance_id)                             ::int as sessions,
       case when count(*) filter (where a.status in ('present','absent')) = 0 then null
            else round(100.0 * count(*) filter (where a.status = 'present')
                       / count(*) filter (where a.status in ('present','absent')), 1) end as attendance_pct,
       ((count(*) filter (where a.status = 'present')
         + case when s.excused_counts_as_attended then count(*) filter (where a.status = 'excused') else 0 end)
          >= s.sessions_required)
        and coalesce(bool_or(a.status = 'present' and x.session_number = ls.n), false) as attendance_eligible,
       coalesce(bool_or(a.status = 'present' and x.session_number = ls.n), false) as signoff_present,
       coalesce(max(a.status) filter (where x.session_number = ls.n), 'not_recorded') as signoff_status
from public.prep_enrolments e
cross join public.prep_settings s
left join last_session ls on ls.cycle_id = e.cycle_id
left join public.prep_attendance a on a.cycle_id = e.cycle_id and a.student_id = e.student_id
left join public.prep_sessions x on x.session_id = a.session_id
group by e.cycle_id, e.student_id, s.excused_counts_as_attended, s.sessions_required;

-- ============================================================================
-- Fees: $200 upfront or $60 per session (both set per cycle; defaults in Settings).
-- Per-session students owe the fee for each session they are marked Present at.
-- A payments user can choose each student's option, or set a one-off fee with a reason.
-- ============================================================================
alter table public.prep_settings
  add column if not exists default_upfront_fee     numeric(10,2) not null default 200 check (default_upfront_fee >= 0),
  add column if not exists default_per_session_fee numeric(10,2) not null default 60  check (default_per_session_fee >= 0),
  add column if not exists default_payment_plan    text not null default 'upfront' check (default_payment_plan in ('upfront','per_session'));

alter table public.prep_cycles
  add column if not exists upfront_fee     numeric(10,2) check (upfront_fee >= 0),
  add column if not exists per_session_fee numeric(10,2) check (per_session_fee >= 0);

alter table public.prep_payments
  add column if not exists payment_plan text check (payment_plan in ('upfront','per_session')),
  add column if not exists fee_override numeric(10,2) check (fee_override >= 0);

-- Cycles without their own fees take the defaults from Settings
update public.prep_cycles c set upfront_fee = coalesce(c.upfront_fee, s.default_upfront_fee),
                                per_session_fee = coalesce(c.per_session_fee, s.default_per_session_fee)
  from public.prep_settings s where s.id = 1 and (c.upfront_fee is null or c.per_session_fee is null);

create or replace function public.prep_cycle_fee_defaults() returns trigger
  language plpgsql security definer set search_path = public as $$
declare s public.prep_settings%rowtype;
begin
  select * into s from public.prep_settings where id = 1;
  new.upfront_fee := coalesce(new.upfront_fee, nullif(new.session_fee, 0), s.default_upfront_fee);
  new.per_session_fee := coalesce(new.per_session_fee, s.default_per_session_fee);
  new.session_fee := new.upfront_fee;   -- older column, kept in step
  return new;
end $$;
drop trigger if exists prep_cycle_fee_defaults on public.prep_cycles;
create trigger prep_cycle_fee_defaults before insert on public.prep_cycles
  for each row execute function public.prep_cycle_fee_defaults();

-- Work out what a student owes for a cycle
create or replace function public.prep_payment_amount() returns trigger
  language plpgsql security definer set search_path = public as $$
declare c public.prep_cycles%rowtype; present int;
begin
  if new.payment_plan is null then
    select default_payment_plan into new.payment_plan from public.prep_settings where id = 1;
  end if;
  if new.fee_override is not null and length(trim(coalesce(new.override_reason, new.notes, ''))) = 0 then
    raise exception 'Give a reason (in the notes) for a one-off fee.';
  end if;
  select * into c from public.prep_cycles where cycle_id = new.cycle_id;
  select count(*) into present from public.prep_attendance
    where cycle_id = new.cycle_id and student_id = new.student_id and status = 'present';
  new.amount_due := coalesce(new.fee_override,
    case new.payment_plan when 'per_session' then coalesce(c.per_session_fee, 0) * present else coalesce(c.upfront_fee, c.session_fee, 0) end);
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists prep_payment_amount on public.prep_payments;
create trigger prep_payment_amount before insert or update on public.prep_payments
  for each row execute function public.prep_payment_amount();

-- Attendance changes update what per-session students owe
create or replace function public.prep_attendance_fee() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    update public.prep_payments set updated_at = now()
      where cycle_id = new.cycle_id and student_id = new.student_id and payment_plan = 'per_session';
  end if;
  return new;
end $$;
drop trigger if exists prep_attendance_fee on public.prep_attendance;
create trigger prep_attendance_fee after update of status on public.prep_attendance
  for each row execute function public.prep_attendance_fee();

-- Changing a cycle's fees updates everyone in it (one-off fees are left alone);
-- also keeps the one-active-cycle rule
create or replace function public.prep_on_cycle_change() returns trigger
  language plpgsql security definer set search_path = public as $$
declare others int; multi boolean;
begin
  new.updated_at := now();
  if new.status = 'active' and old.status is distinct from 'active' then
    select allow_multiple_active into multi from public.prep_settings where id = 1;
    select count(*) into others from public.prep_cycles where status = 'active' and cycle_id <> new.cycle_id;
    if others > 0 and not multi then
      raise exception 'Another cycle is already active. Complete it first, or allow several active cycles in Settings.';
    end if;
  end if;
  if new.session_fee is distinct from old.session_fee and new.upfront_fee is not distinct from old.upfront_fee then
    new.upfront_fee := new.session_fee;
  end if;
  new.session_fee := new.upfront_fee;
  return new;
end $$;

create or replace function public.prep_cycle_fees_changed() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if (new.upfront_fee, new.per_session_fee) is distinct from (old.upfront_fee, old.per_session_fee) then
    update public.prep_payments set updated_at = now() where cycle_id = new.cycle_id;
  end if;
  return new;
end $$;
drop trigger if exists prep_cycle_fees_changed on public.prep_cycles;
create trigger prep_cycle_fees_changed after update on public.prep_cycles
  for each row execute function public.prep_cycle_fees_changed();

-- Recalculate existing fee records under the new rules
update public.prep_payments set updated_at = now();

-- Payment status: a per-session student who has attended nothing owes nothing yet
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
       coalesce(p.due_date, c.payment_due_date) as due_date,
       coalesce(p.status_override,
         case
           when coalesce(t.refunded, 0) > 0 and coalesce(t.paid, 0) <= 0 then 'refunded'
           when p.payment_plan = 'per_session' and p.amount_due = 0 and coalesce(t.paid, 0) = 0 then 'not_invoiced'
           when p.amount_due > 0 and coalesce(t.paid, 0) >= p.amount_due then 'paid'
           when p.amount_due = 0 and p.invoiced_at is not null then 'paid'
           when p.invoiced_at is null then 'not_invoiced'
           when coalesce(p.due_date, c.payment_due_date) < current_date then 'overdue'
           when coalesce(t.paid, 0) > 0 then 'partially_paid'
           else 'due'
         end) as status,
       p.status_override is not null as status_overridden,
       p.override_reason, p.notes,
       p.payment_plan, p.fee_override
from public.prep_payments p
join public.prep_cycles c on c.cycle_id = p.cycle_id
left join t on t.payment_id = p.payment_id;
