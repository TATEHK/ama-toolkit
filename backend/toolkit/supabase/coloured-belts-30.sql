-- Coloured belts 30: an admin's "not grading" call stays on the hub's list even after the family texted STOP
-- (e.g. "STOP - they have stopped attending"). Applied live 9 Nov 2026. Run after coloured-belts-29.sql. Safe to run again.
create or replace function public.cb_calls_due(p_key text)
returns table (call_id uuid, entry_id uuid, school text, parent text, mobile text, student text, belt_from text, belt_to text,
               grading_date date, reason text, note text, tries int, callback_on date, for_admin boolean)
language sql security definer set search_path = public as $$
  select c.call_id, c.entry_id, coalesce(m.location, d.location), coalesce(nullif(m.guardian_name, ''), m.full_name),
         coalesce(nullif(m.guardian_phone, ''), m.phone), e.full_name, e.belt_from, e.belt_to, d.grading_date, c.reason, c.note, c.tries, c.callback_on, c.for_admin
    from cb_calls c
    join cb_entries e on e.entry_id = c.entry_id
    join cb_days d on d.day_id = e.day_id
    left join efc_members m on m.member_key = e.member_key
   where p_key is not null and p_key <> '' and exists (select 1 from cb_settings where skip_key = p_key)
     and not c.done and not coalesce(e.paid, false) and e.result is null and not d.closed
     and (e.seq_stopped_at is null or c.for_admin)   -- a family who texted STOP isn't chased, but an admin still follows up a "not grading"
     and (c.callback_on is null or c.callback_on <= (now() at time zone 'Australia/Sydney')::date)
   order by c.for_admin desc, d.grading_date, e.full_name;
$$;
