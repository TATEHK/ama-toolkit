-- Black Belt Gradings update 23: a grading paid on the booking link marks the grading fee paid.
-- Families pay through their booking link (cb_entries, by card or recorded by staff at the desk). Until now that
-- payment was only on the booking side, so the grading fee in Black Belt Gradings stayed "due" and the enrolment
-- sequence kept nudging people who had paid. This records each booking-link payment as a grading fee payment
-- (one per booking, reference 'cb:<entry_id>'), creates the fee record if it is missing, and takes it off again
-- with a correction if staff mark the booking unpaid. Run once in Supabase > SQL Editor; it also fills in payments made before now.

create or replace function public.prep_sync_cb_entry(p_entry uuid) returns text
  language plpgsql security definer set search_path = public as $$
declare e record; d record; sid text; pay record; amt numeric; net numeric; n int; ref text := 'cb:' || p_entry;
begin
  select * into e from cb_entries where entry_id = p_entry;
  if not found then return 'no entry'; end if;
  select prep_cycle_id, bb, grading_date into d from cb_days where day_id = e.day_id;
  if d.prep_cycle_id is null or not coalesce(d.bb, false) then return 'not a black belt grading'; end if;
  select s.student_id into sid from efc_members m join prep_students s on s.efc_ref = m.efc_reference
   where m.member_key = e.member_key limit 1;
  if sid is null then return 'no linked student'; end if;

  -- What this booking has put on the fee so far (payments minus corrections). Transactions can't be deleted,
  -- so marking a booking unpaid adds a correction that takes its payment back off.
  -- (references are unique, so a repeat or a correction gets 'cb:<entry>:2', 'cb:<entry>:3' ...)
  select coalesce(sum(case type when 'refund' then -amount else amount end), 0), count(*) into net, n
    from prep_payment_transactions where reference = ref or reference like ref || ':%';
  if not coalesce(e.paid, false) then
    if net > 0 then
      insert into prep_payment_transactions (payment_id, student_id, cycle_id, type, amount, paid_on, method, reference, notes, recorded_by)
        select t.payment_id, t.student_id, t.cycle_id, 'correction', -net, (now() at time zone 'Australia/Sydney')::date, 'other', ref || ':' || (n + 1),
               'Booking marked unpaid', 'booking link'
          from prep_payment_transactions t where (t.reference = ref or t.reference like ref || ':%') and t.type = 'payment' limit 1;
    end if;
    return 'unpaid';
  end if;

  insert into prep_payments (student_id, cycle_id, kind, target_rank, invoiced_at, due_date)
    values (sid, d.prep_cycle_id, 'grading', e.belt_to, now(), d.grading_date - 21)
    on conflict (student_id, cycle_id, kind) do nothing;
  select payment_id, amount_due into pay from prep_payments where student_id = sid and cycle_id = d.prep_cycle_id and kind = 'grading';
  if net > 0 then return 'already recorded'; end if;

  amt := coalesce((select cp.amount from cb_payments cp where cp.entry_id = p_entry and cp.status = 'paid' order by cp.paid_at desc nulls last limit 1), pay.amount_due);
  if amt is null or amt <= 0 then return 'no amount'; end if;
  insert into prep_payment_transactions (payment_id, student_id, cycle_id, type, amount, paid_on, method, reference, notes, recorded_by)
    values (pay.payment_id, sid, d.prep_cycle_id, 'payment', amt,
            (coalesce(e.paid_at, now()) at time zone 'Australia/Sydney')::date,
            case e.paid_how when 'card' then 'online' when 'cash' then 'cash' when 'eftpos' then 'card_in_person' when 'transfer' then 'bank_transfer' else 'other' end,
            case when n = 0 then ref else ref || ':' || (n + 1) end, 'Paid on the grading booking link', 'booking link');
  return 'recorded';
end $$;
revoke all on function public.prep_sync_cb_entry(uuid) from public, anon, authenticated;

create or replace function public.prep_sync_cb_paid() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and coalesce(new.paid, false) then perform public.prep_sync_cb_entry(new.entry_id);
  elsif tg_op = 'UPDATE' and coalesce(new.paid, false) is distinct from coalesce(old.paid, false) then perform public.prep_sync_cb_entry(new.entry_id);
  end if;
  return new;
end $$;

drop trigger if exists prep_sync_cb_paid on public.cb_entries;
create trigger prep_sync_cb_paid after insert or update of paid on public.cb_entries
  for each row execute function public.prep_sync_cb_paid();

-- Payments made before this update
select public.prep_sync_cb_entry(e.entry_id)
  from cb_entries e join cb_days d on d.day_id = e.day_id
 where d.bb and d.prep_cycle_id is not null and e.paid;
