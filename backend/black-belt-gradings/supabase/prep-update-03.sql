-- Black Belt Prep: update 03
-- Run once in Supabase > SQL Editor, after prep-update-02.sql. Safe to run again.
-- Per session ($60, paid at each session) becomes the normal fee option; $200 upfront is the exception.
-- Whoever takes attendance can record "paid" for a session with one tap. They see only paid or not paid,
-- never balances. Each session payment is a normal payment transaction, linked to its session.

-- New students start on per session
alter table public.prep_settings alter column default_payment_plan set default 'per_session';
update public.prep_settings set default_payment_plan = 'per_session' where id = 1;

-- Link a payment to the session it was paid at
alter table public.prep_payment_transactions add column if not exists session_id uuid references public.prep_sessions on delete restrict;
create index if not exists prep_tx_session_idx on public.prep_payment_transactions (session_id) where session_id is not null;

-- For the attendance screen: each student's fee option and which sessions they have paid at.
-- No amounts are returned.
create or replace function public.prep_session_fees(p_cycle uuid default null)
returns table (cycle_id uuid, student_id text, payment_plan text, paid_sessions uuid[])
  language sql stable security definer set search_path = public as $$
  select p.cycle_id, p.student_id, p.payment_plan,
         coalesce((select array_agg(x.session_id) from (
                     select t.session_id from public.prep_payment_transactions t
                     where t.payment_id = p.payment_id and t.session_id is not null
                     group by t.session_id
                     having sum(case t.type when 'refund' then -t.amount else t.amount end) > 0) x), '{}')
  from public.prep_payments p
  where (p_cycle is null or p.cycle_id = p_cycle)
    and public.prep_has_role('instructor', 'attendance', 'payments')
$$;
grant execute on function public.prep_session_fees(uuid) to authenticated;

-- Record (or undo) a session payment. Paying records the cycle's per-session fee;
-- undoing records a correction, so the history is kept.
create or replace function public.prep_record_session_payment(p_session uuid, p_student text, p_paid boolean, p_method text default 'cash')
returns boolean language plpgsql security definer set search_path = public as $$
declare se public.prep_sessions%rowtype; c public.prep_cycles%rowtype; pay public.prep_payments%rowtype; net numeric;
begin
  if not public.prep_has_role('instructor', 'attendance', 'payments') then
    raise exception 'You do not have permission to record session payments.';
  end if;
  select * into se from public.prep_sessions where session_id = p_session;
  if not found then raise exception 'Session not found.'; end if;
  select * into c from public.prep_cycles where cycle_id = se.cycle_id;
  select * into pay from public.prep_payments where cycle_id = se.cycle_id and student_id = p_student;
  if not found then raise exception 'That student is not in this cycle.'; end if;
  select coalesce(sum(case type when 'refund' then -amount else amount end), 0) into net
    from public.prep_payment_transactions where payment_id = pay.payment_id and session_id = p_session;
  if p_paid and net <= 0 then
    insert into public.prep_payment_transactions (payment_id, type, amount, paid_on, method, notes, session_id)
      values (pay.payment_id, 'payment', coalesce(c.per_session_fee, 0), coalesce(se.session_date, current_date),
              coalesce(p_method, 'cash'), 'Paid at session ' || se.session_number, p_session);
  elsif not p_paid and net > 0 then
    insert into public.prep_payment_transactions (payment_id, type, amount, notes, session_id)
      values (pay.payment_id, 'correction', -net, 'Session ' || se.session_number || ' payment undone', p_session);
  end if;
  return p_paid;
end $$;
grant execute on function public.prep_record_session_payment(uuid, text, boolean, text) to authenticated;
