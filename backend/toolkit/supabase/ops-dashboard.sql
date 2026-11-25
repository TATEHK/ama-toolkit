-- ops-dashboard: one call that powers the operations dashboard (/admin) — what needs doing right now.
-- Buckets: BBC sign-ups to action, booking errors, failed messages, upcoming gradings at a glance
-- (with helper rostering), and the chase lists (invited-not-booked, booked-not-paid). Each list carries
-- a total count plus a capped set of rows so the page can say "showing 80 of 353".

create or replace function public.cb_ops_dashboard()
returns jsonb language sql stable security definer set search_path to 'public' as $$
with up_days as (
  select * from public.cb_days where grading_date >= current_date and coalesce(closed,false)=false
),
day_counts as (
  select d.day_id, d.location, d.programme, d.grading_date, d.bb, d.makeup, d.private, d.helper_cap, d.helper_open,
    (d.grading_date - current_date) as days_until,
    count(e.entry_id) as total,
    count(e.entry_id) filter (where e.booked_at is not null) as booked,
    count(e.entry_id) filter (where e.paid) as paid,
    count(e.entry_id) filter (where e.invited_at is not null and e.booked_at is null and e.cant_make_at is null) as not_booked,
    (select count(*) from public.cb_helper_signups hs where hs.day_id = d.day_id) as helper_signups
  from up_days d left join public.cb_entries e on e.day_id = d.day_id and e.result is null
  group by d.day_id, d.location, d.programme, d.grading_date, d.bb, d.makeup, d.private, d.helper_cap, d.helper_open
)
select jsonb_build_object(
  'generated_at', now(),

  'bbc_actions', jsonb_build_object(
    'count', (select count(*) from public.cb_bbc_flow where status = 'signed'),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', full_name, 'phone', phone, 'signed_at', signed_at,
        'uniform', uniform_claim, 'waiting_days', (current_date - signed_at::date)) order by signed_at), '[]'::jsonb)
      from public.cb_bbc_flow where status = 'signed')),

  'booking_errors', jsonb_build_object(
    'count', (select count(*) from public.cb_entries e where e.booking_error is not null and e.result is null),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', e.full_name, 'belt_to', e.belt_to, 'location', d.location, 'programme', d.programme, 'grading_date', d.grading_date, 'error', e.booking_error) order by d.grading_date), '[]'::jsonb)
      from public.cb_entries e join public.cb_days d on d.day_id = e.day_id
      where e.booking_error is not null and e.result is null)),

  'failed_messages', jsonb_build_object(
    'count', (select count(*) from public.cb_messages where status = 'failed' and sent_at >= now() - interval '14 days'),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', coalesce(e.full_name, m.full_name), 'kind', msg.kind,
        'channel', case when msg.email is not null then 'email' else 'sms' end,
        'error', msg.error, 'sent_at', msg.sent_at) order by msg.sent_at desc), '[]'::jsonb)
      from (select * from public.cb_messages where status = 'failed' and sent_at >= now() - interval '14 days' order by sent_at desc limit 100) msg
      left join public.cb_entries e on e.entry_id = msg.entry_id
      left join public.efc_members m on m.member_key = msg.member_key)),

  'gradings', (select coalesce(jsonb_agg(jsonb_build_object(
      'day_id', day_id, 'location', location, 'programme', programme, 'grading_date', grading_date, 'bb', bb, 'makeup', makeup, 'private', private,
      'days_until', days_until, 'total', total, 'booked', booked, 'paid', paid, 'not_booked', not_booked,
      'pct_booked', case when total > 0 then round(100.0 * booked / total) else null end,
      'helper_signups', helper_signups, 'helper_cap', helper_cap, 'helper_open', helper_open) order by grading_date, location), '[]'::jsonb)
    from day_counts),

  'chase_not_booked', jsonb_build_object(
    'count', (select count(*) from public.cb_entries e join up_days d on d.day_id = e.day_id
              where e.result is null and e.invited_at is not null and e.booked_at is null and e.cant_make_at is null),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', name, 'belt_to', belt_to, 'location', location, 'programme', programme, 'grading_date', grading_date, 'invited_days_ago', invited_days_ago)
        order by grading_date, invited_days_ago desc), '[]'::jsonb)
      from (select e.full_name as name, e.belt_to, d.location, d.programme, d.grading_date, (current_date - e.invited_at::date) as invited_days_ago
            from public.cb_entries e join up_days d on d.day_id = e.day_id
            where e.result is null and e.invited_at is not null and e.booked_at is null and e.cant_make_at is null
            order by d.grading_date, e.invited_at limit 100) t)),

  'chase_unpaid', jsonb_build_object(
    'count', (select count(*) from public.cb_entries e join up_days d on d.day_id = e.day_id
              where e.result is null and e.booked_at is not null and e.paid = false),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', e.full_name, 'belt_to', e.belt_to, 'location', d.location, 'programme', d.programme, 'grading_date', d.grading_date,
        'booked_days_ago', (current_date - e.booked_at::date)) order by d.grading_date), '[]'::jsonb)
      from public.cb_entries e join up_days d on d.day_id = e.day_id
      where e.result is null and e.booked_at is not null and e.paid = false))
) $$;

grant execute on function public.cb_ops_dashboard() to authenticated;
