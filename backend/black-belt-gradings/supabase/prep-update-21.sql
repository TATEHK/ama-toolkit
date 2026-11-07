-- Black Belt Prep: update 21 — the Day-12 call list for Mark's hub (secured by the nurture hub key)
-- Run once in Supabase > SQL Editor. Safe to run again.
--
-- prep_calls_due(key) returns the students a staff member should call today: everyone still unpaid once the Day-12
-- call row has been made, plus any reply-driven "concern" call-backs that are due. Paid or no-longer-grading
-- students never appear. prep_call_outcome(...) logs one of the five outcomes and writes the result back.

create or replace function public.prep_calls_due(p_key text)
returns table (cycle_id uuid, student_id text, full_name text, mobile text, belt text, reason text, note text, callback_on date)
language sql security definer set search_path = public as $$
  select pc.cycle_id, pc.student_id, s.full_name, s.contact_phone as mobile, o.grading_to as belt, pc.reason, pc.note, pc.callback_on
    from public.prep_calls pc
    join public.prep_nurture_runs r on r.cycle_id = pc.cycle_id and r.started_at is not null
    join public.prep_students s on s.student_id = pc.student_id
    left join public.prep_overview o on o.cycle_id = pc.cycle_id and o.student_id = pc.student_id
   where p_key is not null and p_key <> '' and p_key = (select nurture_hub_key from public.prep_settings where id = 1)
     and not pc.done
     and (pc.callback_on is null or pc.callback_on <= (now() at time zone 'Australia/Sydney')::date)
     and coalesce(o.grading_fee_status, '') not in ('paid', 'waived')
     and coalesce(o.is_grading, true)
   order by s.full_name;
$$;

create or replace function public.prep_call_outcome(p_key text, p_cycle uuid, p_student text, p_outcome text, p_note text default null, p_callback date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_key is null or p_key = '' or p_key <> (select nurture_hub_key from public.prep_settings where id = 1) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  if p_outcome not in ('enrolling', 'will_enrol', 'not_grading', 'no_answer', 'wrong_number') then
    raise exception 'Unknown outcome.';
  end if;
  update public.prep_calls
     set outcome = p_outcome, outcome_note = p_note, callback_on = coalesce(p_callback, callback_on),
         done = p_outcome in ('enrolling', 'not_grading', 'wrong_number'), updated_at = now()
   where cycle_id = p_cycle and student_id = p_student and not done;
  get diagnostics n = row_count;
  if p_outcome = 'not_grading' then
    update public.prep_enrolments set is_grading = false where cycle_id = p_cycle and student_id = p_student;
    insert into public.prep_nurture_state (cycle_id, student_id, stopped) values (p_cycle, p_student, true)
      on conflict (cycle_id, student_id) do update set stopped = true, updated_at = now();
  end if;
  return n;
end $$;

revoke all on function public.prep_calls_due(text) from public;
revoke all on function public.prep_call_outcome(text, uuid, text, text, text, date) from public;
grant execute on function public.prep_calls_due(text) to anon, authenticated;
grant execute on function public.prep_call_outcome(text, uuid, text, text, text, date) to anon, authenticated;
