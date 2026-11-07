-- Black Belt Prep: update 05 (deleting students; upfront payments from the attendance screen)
-- Run once in Supabase > SQL Editor, after prep-update-04.sql. Safe to run again.
-- Delete students added by mistake. A student is deleted only if they have no payments, grading records
-- or certificates; their cycle places, attendance, readiness, fee records and Dan numbers go with them.
-- Students with that history are skipped (deactivate them instead). The audit log keeps a record.

create or replace function public.prep_delete_students(p_ids text[])
returns table (student_id text, full_name text, deleted boolean, reason text)
language plpgsql security definer set search_path = public as $$
declare s record; why text;
begin
  if not public.prep_has_role('admin') then raise exception 'Only an admin can delete students.'; end if;
  for s in select st.student_id, st.full_name from public.prep_students st where st.student_id = any(p_ids) order by st.full_name loop
    why := case
      when exists (select 1 from public.prep_payment_transactions t where t.student_id = s.student_id) then 'Has payments recorded'
      when exists (select 1 from public.prep_grading g where g.student_id = s.student_id) then 'Has grading records'
      when exists (select 1 from public.prep_certificates c where c.student_id = s.student_id) then 'Has certificates'
    end;
    if why is null then
      delete from public.prep_print_event_notes where prep_print_event_notes.student_id = s.student_id;
      delete from public.prep_id_cards where prep_id_cards.student_id = s.student_id;
      delete from public.prep_dan_numbers where prep_dan_numbers.student_id = s.student_id;
      delete from public.prep_readiness_history where prep_readiness_history.student_id = s.student_id;
      delete from public.prep_enrolments where prep_enrolments.student_id = s.student_id;   -- removes attendance, readiness, fee records
      update public.people set student_id = null where people.student_id = s.student_id;    -- unlink from the card software (card kept)
      delete from public.prep_students where prep_students.student_id = s.student_id;
    end if;
    student_id := s.student_id; full_name := s.full_name; deleted := why is null; reason := why;
    return next;
  end loop;
end $$;
grant execute on function public.prep_delete_students(text[]) to authenticated;

-- ============================================================================
-- Upfront students: one tap on $ records the full upfront fee, and every session then shows as paid.
-- Attendance is recorded separately.
-- ============================================================================
drop function if exists public.prep_session_fees(uuid);
create function public.prep_session_fees(p_cycle uuid default null)
returns table (cycle_id uuid, student_id text, payment_plan text, paid_sessions uuid[], prepaid boolean)
  language sql stable security definer set search_path = public as $$
  select p.cycle_id, p.student_id, p.payment_plan,
         coalesce((select array_agg(x.session_id) from (
                     select t.session_id from public.prep_payment_transactions t
                     where t.payment_id = p.payment_id and t.session_id is not null
                     group by t.session_id
                     having sum(case t.type when 'refund' then -t.amount else t.amount end) > 0) x), '{}'),
         p.payment_plan = 'upfront' and p.amount_due > 0 and coalesce((
           select sum(case t.type when 'refund' then -t.amount else t.amount end)
           from public.prep_payment_transactions t where t.payment_id = p.payment_id), 0) >= p.amount_due
  from public.prep_payments p
  where p.kind = 'sessions' and (p_cycle is null or p.cycle_id = p_cycle)
    and public.prep_has_role('instructor', 'attendance', 'payments')
$$;
grant execute on function public.prep_session_fees(uuid) to authenticated;

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

  if pay.payment_plan = 'upfront' then
    -- The whole upfront fee, covering every session
    select coalesce(sum(case type when 'refund' then -amount else amount end), 0) into net
      from public.prep_payment_transactions where payment_id = pay.payment_id;
    if p_paid and net < pay.amount_due then
      insert into public.prep_payment_transactions (payment_id, type, amount, paid_on, method, notes)
        values (pay.payment_id, 'payment', pay.amount_due - net, current_date,
                coalesce(p_method, 'cash'), 'Paid upfront (all sessions), taken at session ' || se.session_number);
    elsif not p_paid and net > 0 then
      insert into public.prep_payment_transactions (payment_id, type, amount, notes)
        values (pay.payment_id, 'correction', -net, 'Upfront payment undone');
    end if;
    return p_paid;
  end if;

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
