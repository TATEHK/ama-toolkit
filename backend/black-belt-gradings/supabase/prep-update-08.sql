-- Black Belt Prep: update 08 (delete students anyway)
-- Run once in Supabase > SQL Editor, after prep-update-07.sql. Safe to run again.
-- Admins can now delete a student who has payments, grading records or certificates, after a second
-- confirmation in the app. Everything about that student goes, including their payments (so payment
-- totals change). Every removed row is still kept in the audit log (More > Recent changes).
-- Without "delete anyway", deleting works as before: students with that history are skipped.

-- Payment transactions stay locked, except while an admin is deleting a student anyway
create or replace function public.prep_tx_locked() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('prep.force_delete', true) = 'on' then return old; end if;
  raise exception 'Payment transactions cannot be changed or deleted. Record a correction instead.';
end $$;

drop function if exists public.prep_delete_students(text[]);
create or replace function public.prep_delete_students(p_ids text[], p_force boolean default false)
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
    if why is null or p_force then
      if why is not null then
        perform set_config('prep.force_delete', 'on', true);
        delete from public.prep_payment_transactions t where t.student_id = s.student_id;
        perform set_config('prep.force_delete', 'off', true);
        delete from public.prep_certificates c where c.student_id = s.student_id;
        delete from public.prep_grading g where g.student_id = s.student_id;
      end if;
      delete from public.prep_print_event_notes where prep_print_event_notes.student_id = s.student_id;
      delete from public.prep_id_cards where prep_id_cards.student_id = s.student_id;
      delete from public.prep_dan_numbers where prep_dan_numbers.student_id = s.student_id;
      delete from public.prep_readiness_history where prep_readiness_history.student_id = s.student_id;
      delete from public.prep_enrolments where prep_enrolments.student_id = s.student_id;   -- removes attendance, readiness, fee records
      update public.people set student_id = null where people.student_id = s.student_id;    -- unlink from the card software (card kept)
      delete from public.prep_students where prep_students.student_id = s.student_id;
      why := null;
    end if;
    student_id := s.student_id; full_name := s.full_name; deleted := why is null; reason := why;
    return next;
  end loop;
end $$;
grant execute on function public.prep_delete_students(text[], boolean) to authenticated;
