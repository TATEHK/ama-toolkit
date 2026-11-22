-- Extend the activity log + 24h undo to AMA ID Cards (the people table).
-- Logs card deletions (high, with reinsert undo) and edits to the real fields
-- (name, dob, dan, issued, student_id) as normal risk; ignores routine photo/print churn.
-- AFTER trigger, wrapped so it can never block a save.

create or replace function public.card_log() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  actor text; who text; nm text; act text; rsk text := 'high'; summ text; snap jsonb; undo jsonb; hrs int;
begin
  begin actor := nullif(auth.jwt() ->> 'email', ''); exception when others then actor := null; end;
  who := coalesce(actor, 'Someone'); nm := coalesce(new.name, old.name, 'someone');
  begin
    if tg_op = 'DELETE' then
      act := 'card.delete'; summ := who || ' deleted the ID card for ' || nm; snap := to_jsonb(old);
      undo := jsonb_build_object('table', 'people', 'reinsert', to_jsonb(old));
    elsif tg_op = 'UPDATE' then
      if (new.name, new.dob, new.dan, new.issued, new.student_id) is not distinct from (old.name, old.dob, old.dan, old.issued, old.student_id) then return new; end if;
      act := 'card.edit'; rsk := 'normal'; summ := who || ' edited ' || nm || '''s ID card'; snap := to_jsonb(old);
      undo := jsonb_build_object('table', 'people', 'key', jsonb_build_object('id', old.id), 'set',
        jsonb_build_object('name', old.name, 'dob', old.dob, 'dan', old.dan, 'issued', old.issued, 'student_id', old.student_id));
    else
      return new;
    end if;
    select undo_hours into hrs from public.alert_settings where id = 1;
    insert into public.activity_log(actor_email, app, action, risk, summary, target, snapshot, undo, undo_token, undo_expires, batch)
      values (actor, 'cards', act, rsk, summ, nm, snap, undo, replace(gen_random_uuid()::text, '-', ''), now() + make_interval(hours => coalesce(hrs, 24)), txid_current()::text);
  exception when others then null;
  end;
  return coalesce(new, old);
end $$;

drop trigger if exists card_log_people on public.people;
create trigger card_log_people after update or delete on public.people for each row execute function public.card_log();
