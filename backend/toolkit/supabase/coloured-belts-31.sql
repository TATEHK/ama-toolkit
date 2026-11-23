-- Coloured belts 31: cb_paid_summary — a read-only feed for the hub's management dashboard (grading pace).
-- One row per PAID coloured-belt grading in the current round (entries on grading days that aren't closed):
-- the student's school, the belt they're grading from, the amount paid, and the date paid.
-- Hub-key gated the same way as cb_calls_due (cb_settings.skip_key). Reads only; changes nothing else.

create or replace function public.cb_paid_summary(p_key text)
returns table (school text, belt_from text, amount numeric, paid_on date)
language sql security definer set search_path = public as $$
  select coalesce(m.location, d.location) as school,
         e.belt_from,
         case when bf.fee is null then null
           else bf.fee - case
             when coalesce(e.discount, 0) <= 0 then 0
             when e.discount_kind = 'percent' then least(bf.fee, round(bf.fee * least(e.discount, 100)) / 100.0)
             else least(e.discount, bf.fee)
           end
         end as amount,
         (e.paid_at at time zone 'Australia/Sydney')::date as paid_on
    from cb_entries e
    join cb_days d on d.day_id = e.day_id
    left join efc_members m on m.member_key = e.member_key
    left join lateral (
      select b.fee from cb_belts b
       where b.belt = e.belt_from
       order by (coalesce(b.programme, 'Taekwondo') = coalesce(d.programme, 'Taekwondo')) desc
       limit 1
    ) bf on true
   where p_key is not null and p_key <> '' and exists (select 1 from cb_settings where skip_key = p_key)
     and coalesce(e.paid, false) and not coalesce(d.closed, false)
   order by e.paid_at nulls last, e.full_name;
$$;
revoke all on function public.cb_paid_summary(text) from public;
grant execute on function public.cb_paid_summary(text) to anon, authenticated;
