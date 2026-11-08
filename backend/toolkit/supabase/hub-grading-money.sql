-- AMA Toolkit: grading money report for the AMA hub's management dashboard (8 Nov 2026, Mark)
-- Run once in Supabase > SQL Editor. Safe to run again.
--
-- READ ONLY. Adds one new function and changes nothing else: no tables, columns, policies, keys or existing functions.
-- It checks the hub's existing key (cb_settings.skip_key, the same one cb_skip_sync uses), so no new key is needed.
-- The hub calls it a few times an hour:  POST /rest/v1/rpc/hub_grading_money  { "p_key": "<skip_key>" }
--
-- Returns one row per student for current gradings (colour belt days from 60 days ago onwards, and black belt
-- cycles that are active or grading from 60 days ago onwards), plus polo orders. The hub does the totals.
-- Names and contact details are NOT returned, only what's needed for the money report.

create or replace function public.hub_grading_money(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from date := current_date - 60;
begin
  if p_key is null or not exists (select 1 from cb_settings where skip_key = p_key) then raise exception 'Wrong key.'; end if;
  return jsonb_build_object(
    'at', now(),

    -- Colour belt and other programs: one row per student on a grading day (black belt days excluded)
    'colour', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day_id', d.day_id, 'date', d.grading_date, 'time', to_char(d.start_time, 'HH24:MI'),
        'location', d.location, 'programme', coalesce(d.programme, 'Taekwondo'),
        'school', coalesce(e.school, d.location), 'belt_from', e.belt_from, 'belt_to', e.belt_to,
        'invited', e.invited_at is not null, 'yes', e.yes_at is not null, 'booked', e.booked_at is not null,
        'paid', e.paid, 'paid_at', e.paid_at, 'paid_how', e.paid_how,
        'fee', coalesce(b.fee, 0),
        'card', (select sum(p.amount) from cb_payments p where p.entry_id = e.entry_id and p.status = 'paid')))
      from cb_entries e
      join cb_days d on d.day_id = e.day_id
      left join cb_belts b on b.belt = e.belt_from and b.programme = coalesce(d.programme, 'Taekwondo')
      where d.grading_date >= v_from and coalesce(d.bb, false) = false), '[]'::jsonb),

    -- Black belt: one row per student per charge (kind 'grading' = grading fee, 'sessions' = prep session fees)
    'black', coalesce((
      select jsonb_agg(jsonb_build_object(
        'cycle', c.name, 'grading_date', c.grading_date, 'kind', pp.kind,
        'target_rank', pp.target_rank, 'belt', s.belt_rank, 'club', s.club,
        'due', coalesce(pp.fee_override, pp.amount_due, 0),
        'paid', coalesce((select sum(case when t.type = 'refund' then -abs(t.amount) else t.amount end)
                          from prep_payment_transactions t where t.payment_id = pp.payment_id), 0),
        'cash', coalesce((select sum(t.amount) from prep_payment_transactions t
                          where t.payment_id = pp.payment_id and t.type = 'payment' and t.method = 'cash'), 0),
        'online', coalesce((select sum(t.amount) from prep_payment_transactions t
                            where t.payment_id = pp.payment_id and t.type = 'payment' and t.method = 'online'), 0),
        'refunds', coalesce((select sum(abs(t.amount)) from prep_payment_transactions t
                             where t.payment_id = pp.payment_id and t.type = 'refund'), 0),
        'paid_week', coalesce((select sum(case when t.type = 'refund' then -abs(t.amount) else t.amount end)
                               from prep_payment_transactions t
                               where t.payment_id = pp.payment_id and t.paid_on >= current_date - 7), 0),
        'last_paid', (select max(t.paid_on) from prep_payment_transactions t
                      where t.payment_id = pp.payment_id and t.type = 'payment')))
      from prep_payments pp
      join prep_cycles c on c.cycle_id = pp.cycle_id
      join prep_students s on s.student_id = pp.student_id
      where (c.status = 'active' or c.grading_date >= v_from) and not coalesce(s.is_test, false)), '[]'::jsonb),

    -- Black belt polo orders (this year)
    'polo', coalesce((
      select jsonb_agg(jsonb_build_object('qty', o.qty, 'amount', o.amount, 'status', o.status,
                                          'paid_at', o.paid_at, 'paid_how', o.paid_how))
      from prep_polo_orders o
      where o.year::text = to_char(current_date, 'YYYY')), '[]'::jsonb)
  );
end $$;

revoke all on function public.hub_grading_money(text) from public;
grant execute on function public.hub_grading_money(text) to anon, authenticated;

-- Check it (paste the skip_key from Table Editor > cb_settings):
--   select jsonb_array_length(r->'colour') colour_rows, jsonb_array_length(r->'black') black_rows
--   from (select public.hub_grading_money('<skip_key>') r) x;
