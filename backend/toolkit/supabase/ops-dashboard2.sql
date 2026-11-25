-- Second Operations dashboard payload (keeps cb_ops_dashboard small). Powers the belt order list,
-- countdown checklist, who's-on-today, "can't make it" reasons, retest tracker and BBC conversion.
-- Needs the Operations permission ('ops'); admins always pass.

create or replace function public.cb_ops_dashboard2()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['ops']) then raise exception 'not allowed' using errcode='42501'; end if;
  return jsonb_build_object(
    'generated_at', now(),

    'belt_order', (select coalesce(jsonb_agg(jsonb_build_object(
        'location', location, 'belt_to', belt_to, 'booked', booked, 'invited', invited) order by location, booked desc, belt_to), '[]'::jsonb)
      from (select d.location, e.belt_to,
              count(*) filter (where e.booked_at is not null) as booked,
              count(*) filter (where e.invited_at is not null and e.booked_at is null) as invited
            from public.cb_entries e join public.cb_days d on d.day_id = e.day_id
            where d.grading_date >= current_date and coalesce(d.closed,false)=false and e.result is null and e.belt_to is not null
            group by d.location, e.belt_to) t),

    'countdown', (select coalesce(jsonb_agg(jsonb_build_object(
        'day_id', d.day_id, 'grading_date', d.grading_date, 'location', d.location, 'programme', d.programme, 'bb', d.bb,
        'days_until', (d.grading_date - current_date),
        'invites_out', (select count(*) from public.cb_entries e where e.day_id=d.day_id and e.invited_at is not null) > 0,
        'total', (select count(*) from public.cb_entries e where e.day_id=d.day_id and e.result is null),
        'booked', (select count(*) from public.cb_entries e where e.day_id=d.day_id and e.result is null and e.booked_at is not null),
        'paid', (select count(*) from public.cb_entries e where e.day_id=d.day_id and e.result is null and e.paid),
        'helper_signups', (select count(*) from public.cb_helper_signups hs where hs.day_id=d.day_id),
        'helper_cap', d.helper_cap,
        'floor_set', d.belt_times is not null
        ) order by d.grading_date, d.location), '[]'::jsonb)
      from public.cb_days d where d.grading_date >= current_date and coalesce(d.closed,false)=false),

    'whos_on_today', (select coalesce(jsonb_agg(jsonb_build_object(
        'day_id', d.day_id, 'location', d.location, 'bb', d.bb, 'start_time', d.start_time,
        'helpers', (select coalesce(jsonb_agg(h.full_name order by h.full_name), '[]'::jsonb)
                    from public.cb_helper_signups hs join public.cb_helpers h on h.helper_id=hs.helper_id where hs.day_id=d.day_id)
        ) order by d.start_time, d.location), '[]'::jsonb)
      from public.cb_days d where coalesce(d.closed,false)=false and (d.grading_date=current_date or d.started_prompt_at is not null)),

    'cant_make', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', e.full_name, 'belt_to', e.belt_to, 'location', d.location, 'programme', d.programme, 'grading_date', d.grading_date,
        'reason', e.cant_make_reason, 'when', e.cant_make_at) order by e.cant_make_at desc), '[]'::jsonb)
      from public.cb_entries e join public.cb_days d on d.day_id=e.day_id
      where e.cant_make_at > now() - interval '90 days'),

    'retest', (select coalesce(jsonb_agg(obj order by rb, gd desc), '[]'::jsonb) from (
        select (exists(select 1 from public.cb_entries e2 join public.cb_days d2 on d2.day_id=e2.day_id
                   where e2.member_key=e.member_key and e2.member_key is not null and e2.entry_id<>e.entry_id
                     and d2.grading_date > d.grading_date and e2.booked_at is not null)) as rb,
               d.grading_date gd,
               jsonb_build_object('name', e.full_name, 'belt_to', e.belt_to, 'location', d.location, 'programme', d.programme,
                 'grading_date', d.grading_date, 'result', e.result,
                 'rebooked', (exists(select 1 from public.cb_entries e2 join public.cb_days d2 on d2.day_id=e2.day_id
                   where e2.member_key=e.member_key and e2.member_key is not null and e2.entry_id<>e.entry_id
                     and d2.grading_date > d.grading_date and e2.booked_at is not null))) obj
        from public.cb_entries e join public.cb_days d on d.day_id=e.day_id
        where e.result in ('fail','absent') and d.grading_date between current_date - 120 and current_date) t),

    'bbc_conversion', (select coalesce(jsonb_agg(jsonb_build_object(
        'school', school, 'entered', entered, 'signed', signed,
        'pct', case when entered>0 then round(100.0*signed/entered) else null end) order by entered desc, school), '[]'::jsonb)
      from (select coalesce(d.location,'(no school)') school, count(*) entered, count(*) filter (where f.status='signed') signed
            from public.cb_bbc_flow f left join public.cb_days d on d.day_id=f.day_id
            group by coalesce(d.location,'(no school)')) t)
  );
end $$;
grant execute on function public.cb_ops_dashboard2() to authenticated;
