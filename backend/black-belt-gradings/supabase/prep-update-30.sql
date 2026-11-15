-- prep-update-30.sql: 4th Dan helper sessions only balance when a session is getting full.
-- Caps were raised from 6 to 10, but the even-spread still bounced a 4th Dan off any session that was even
-- slightly ahead -- so with sessions nearly empty people were told a session "has enough helpers" for no real
-- reason. Now a 4th Dan gets the single session they pick unless that session is within 2 of its cap AND an
-- emptier session has room; only then are they steered to the emptier one.
-- (The matching "what to offer / re-offer" logic lives in the nurture + cb functions.)

create or replace function public.prep_helper_claim(p_cycle uuid, p_student text, p_slots uuid[], p_reply text default null, p_by text default 'reply', p_balance boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.prep_helper_slots; sid uuid; n int; low int; sen boolean; mine uuid[]; oks uuid[] := '{}'; fulls uuid[] := '{}'; unev uuid[] := '{}';
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and not public.prep_has_role('grading', 'calls') then raise exception 'Not allowed'; end if;
  perform 1 from public.prep_helper_slots where cycle_id = p_cycle order by slot_id for update;   -- one claim at a time per cycle
  select coalesce((select senior from public.prep_helpers where cycle_id = p_cycle and student_id = p_student), true),
         coalesce((select slot_ids from public.prep_helpers where cycle_id = p_cycle and student_id = p_student), '{}')
    into sen, mine;
  foreach sid in array (select coalesce(array_agg(distinct x), '{}') from unnest(p_slots) x) loop
    select * into s from public.prep_helper_slots where slot_id = sid and cycle_id = p_cycle;
    if not found then continue; end if;
    if sid = any(mine) then oks := oks || sid; continue; end if;
    select count(*) into n from public.prep_helpers where sid = any(slot_ids) and student_id <> p_student and senior;
    if sen and n >= s.cap then fulls := fulls || sid; continue; end if;
    -- Only balance when this session is getting close to its cap (within 2); below that, they get what they picked.
    if p_balance and sen and cardinality(p_slots) = 1 and n >= s.cap - 2 then
      select min(c) into low from (
        select (select count(*) from public.prep_helpers h where x.slot_id = any(h.slot_ids) and h.student_id <> p_student and h.senior) c, x.cap
        from public.prep_helper_slots x where x.cycle_id = p_cycle) t where c < cap;
      if n > coalesce(low, n) then unev := unev || sid; continue; end if;
    end if;
    mine := mine || sid; oks := oks || sid;
  end loop;
  if cardinality(oks) > 0 then
    insert into public.prep_helpers (cycle_id, student_id, slot_ids, confirmed_at, declined_at, reply_text, set_by, updated_at)
    values (p_cycle, p_student, mine, now(), null, p_reply, p_by, now())
    on conflict (cycle_id, student_id) do update set slot_ids = excluded.slot_ids, confirmed_at = now(), declined_at = null,
      reply_text = coalesce(excluded.reply_text, public.prep_helpers.reply_text), set_by = excluded.set_by, updated_at = now();
  end if;
  return jsonb_build_object('ok', to_jsonb(oks), 'full', to_jsonb(fulls), 'uneven', to_jsonb(unev));
end $$;
