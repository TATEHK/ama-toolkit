-- Extend the activity log + 24h undo to Black Belt Gradings (prep_grading, prep_students, prep_payments).
-- Mirrors cb_entries_log: AFTER trigger, wrapped so it can never block a save; records belt/rank changes,
-- grading results, eligibility, target rank, payment status/fee overrides and deletions, with a before-snapshot
-- and an undo spec. Test students (prep_students.is_test) are ignored.
-- NOTE: not yet applied to the live database (the SQL tool's confirmation prompt went unanswered). Apply this
-- as a migration once the database path is available.

create or replace function public.bb_log() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  actor text; who text; nm text; istest boolean := false;
  act text; rsk text := 'high'; summ text; snap jsonb; undo jsonb; hrs int; keyjson jsonb; setjson jsonb;
begin
  begin actor := nullif(auth.jwt() ->> 'email', ''); exception when others then actor := null; end;
  who := coalesce(actor, 'Someone');
  if tg_table_name = 'prep_students' then
    nm := coalesce(new.full_name, old.full_name, 'a student'); istest := coalesce(new.is_test, old.is_test, false);
  else
    select full_name, is_test into nm, istest from public.prep_students where student_id = coalesce(new.student_id, old.student_id);
    nm := coalesce(nm, 'a student');
  end if;
  if istest then return coalesce(new, old); end if;
  begin
    if tg_op = 'DELETE' then
      act := replace(tg_table_name, 'prep_', '') || '.delete';
      summ := who || ' deleted a ' || replace(tg_table_name, 'prep_', '') || ' record for ' || nm;
      snap := to_jsonb(old); undo := jsonb_build_object('table', tg_table_name, 'reinsert', to_jsonb(old));
    elsif tg_op = 'UPDATE' then
      if to_jsonb(new) = to_jsonb(old) then return new; end if;
      if tg_table_name = 'prep_students' then
        if new.belt_rank is distinct from old.belt_rank then act := 'belt.change'; summ := who || ' changed ' || nm || '''s rank: ' || coalesce(old.belt_rank, '?') || ' -> ' || coalesce(new.belt_rank, '?');
        elsif new.is_active is distinct from old.is_active and new.is_active = false then act := 'student.deactivate'; summ := who || ' made ' || nm || ' inactive';
        else act := 'bb.edit'; rsk := 'normal'; summ := who || ' edited ' || nm; end if;
        keyjson := jsonb_build_object('student_id', old.student_id);
        setjson := jsonb_build_object('belt_rank', old.belt_rank, 'is_active', old.is_active, 'full_name', old.full_name);
      elsif tg_table_name = 'prep_grading' then
        if new.result is distinct from old.result then act := 'result.change'; summ := who || ' set ' || nm || '''s black belt result to ' || coalesce(new.result, '(cleared)');
        elsif new.eligibility_decision is distinct from old.eligibility_decision then act := 'eligibility.change'; summ := who || ' changed ' || nm || '''s eligibility to ' || coalesce(new.eligibility_decision, '(cleared)');
        elsif new.target_rank is distinct from old.target_rank then act := 'target.change'; summ := who || ' changed ' || nm || '''s target rank to ' || coalesce(new.target_rank, '?');
        else act := 'bb.edit'; rsk := 'normal'; summ := who || ' edited ' || nm || '''s grading record'; end if;
        keyjson := jsonb_build_object('grading_id', old.grading_id);
        setjson := jsonb_build_object('result', old.result, 'eligibility_decision', old.eligibility_decision, 'target_rank', old.target_rank, 'status', old.status);
      else   -- prep_payments
        if new.status_override is distinct from old.status_override then act := 'payment.override'; summ := who || ' changed ' || nm || '''s black belt payment status';
        elsif new.fee_override is distinct from old.fee_override then act := 'fee.set'; summ := who || ' changed ' || nm || '''s black belt fee';
        else act := 'bb.edit'; rsk := 'normal'; summ := who || ' edited ' || nm || '''s payment'; end if;
        keyjson := jsonb_build_object('payment_id', old.payment_id);
        setjson := jsonb_build_object('status_override', old.status_override, 'fee_override', old.fee_override, 'amount_due', old.amount_due);
      end if;
      snap := to_jsonb(old); undo := jsonb_build_object('table', tg_table_name, 'key', keyjson, 'set', setjson);
    else
      return new;   -- INSERT: not logged
    end if;
    select undo_hours into hrs from public.alert_settings where id = 1;
    insert into public.activity_log(actor_email, app, action, risk, summary, target, snapshot, undo, undo_token, undo_expires, batch)
      values (actor, 'bb', act, rsk, summ, nm, snap, undo, replace(gen_random_uuid()::text, '-', ''), now() + make_interval(hours => coalesce(hrs, 24)), txid_current()::text);
  exception when others then null;
  end;
  return coalesce(new, old);
end $$;

drop trigger if exists bb_log_grading on public.prep_grading;
create trigger bb_log_grading after update or delete on public.prep_grading for each row execute function public.bb_log();
drop trigger if exists bb_log_students on public.prep_students;
create trigger bb_log_students after update or delete on public.prep_students for each row execute function public.bb_log();
drop trigger if exists bb_log_payments on public.prep_payments;
create trigger bb_log_payments after update or delete on public.prep_payments for each row execute function public.bb_log();
