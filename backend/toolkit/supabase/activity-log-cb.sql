-- Slice 1: record every change to coloured-belt grading entries (belts, results, payments, deletes) in the
-- activity_log, with a before-snapshot and an undo spec, so a mistake can be reversed for 24h.
-- An AFTER trigger: it never blocks the underlying change (all logging is wrapped so an error here can't stop a save).
-- Works for both staff (direct, authenticated) and the app's own functions (service role; actor then unknown).

alter table public.activity_log add column if not exists batch text;   -- rows changed together (one statement) share this

create or replace function public.cb_entries_log() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  actor text := nullif(auth.jwt() ->> 'email', '');
  who text := coalesce(actor, 'Someone');
  nm text := coalesce(new.full_name, old.full_name, 'a student');
  act text; rsk text := 'high'; summ text; snap jsonb; undo jsonb; hrs int;
begin
  begin
    if tg_op = 'INSERT' then
      insert into public.activity_log(actor_email, app, action, risk, summary, target, batch)
        values (actor, 'cb', 'entry.add', 'normal', who || ' added ' || nm || ' to a grading day', nm, txid_current()::text);
      return new;
    elsif tg_op = 'DELETE' then
      act := 'entry.delete'; summ := who || ' removed ' || nm || ' from a grading day'; snap := to_jsonb(old);
      undo := jsonb_build_object('table', 'cb_entries', 'reinsert', to_jsonb(old));
    else
      if to_jsonb(new) = to_jsonb(old) then return new; end if;   -- nothing actually changed
      if (new.belt_from, new.belt_to) is distinct from (old.belt_from, old.belt_to) then
        act := 'belt.change'; summ := who || ' changed ' || nm || '''s belt: ' || coalesce(old.belt_from, '?') || ' → ' || coalesce(new.belt_to, '?');
      elsif (new.result, new.result_at) is distinct from (old.result, old.result_at) then
        act := 'result.change'; summ := who || ' set ' || nm || '''s result to ' || coalesce(new.result, '(cleared)');
      elsif new.paid is distinct from old.paid then
        act := case when new.paid then 'payment.record' else 'payment.unset' end;
        summ := who || case when new.paid then ' marked ' || nm || ' paid' else ' un-marked ' || nm || ' as paid' end;
      elsif (new.discount, new.discount_kind) is distinct from (old.discount, old.discount_kind) then
        act := 'discount.set'; summ := who || ' changed ' || nm || '''s discount';
      else
        act := 'entry.edit'; rsk := 'normal'; summ := who || ' edited ' || nm || '''s grading entry';
      end if;
      snap := to_jsonb(old);
      -- undo restores the editable fields to their previous values
      undo := jsonb_build_object('table', 'cb_entries', 'key', jsonb_build_object('entry_id', old.entry_id), 'set',
        jsonb_build_object('belt_from', old.belt_from, 'belt_to', old.belt_to, 'to_programme', old.to_programme,
          'result', old.result, 'result_at', old.result_at, 'paid', old.paid, 'paid_how', old.paid_how,
          'discount', old.discount, 'discount_kind', old.discount_kind, 'discount_reason', old.discount_reason, 'discount_note', old.discount_note));
    end if;
    select undo_hours into hrs from public.alert_settings where id = 1;
    insert into public.activity_log(actor_email, app, action, risk, summary, target, snapshot, undo, undo_token, undo_expires, batch)
      values (actor, 'cb', act, rsk, summ, nm, snap, undo, encode(gen_random_bytes(9), 'hex'),
              now() + make_interval(hours => coalesce(hrs, 24)), txid_current()::text);
  exception when others then null;   -- logging must never block the action
  end;
  return coalesce(new, old);
end $$;

drop trigger if exists cb_entries_log_t on public.cb_entries;
create trigger cb_entries_log_t after insert or update or delete on public.cb_entries
  for each row execute function public.cb_entries_log();
