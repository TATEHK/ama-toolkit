-- AMA Toolkit: coloured belt grading, update 7 (pay the grading fee by card, then book the EFC session automatically)
-- Run once in Supabase > SQL Editor, after coloured-belts-6.sql. Safe to run again.
-- A family's booking link can take the fee by card (Stripe Checkout). When Stripe confirms the payment the "cb" function marks
-- them paid and sends the booking to your Zap, which books the EFC grading session (set that session to $0 in EFC so
-- EFC doesn't charge again). Families can still book and pay at the front desk instead.

-- How it was paid: 'card' (Stripe) or 'desk' (marked by staff)
alter table public.cb_entries add column if not exists paid_how text;

-- Card payments. Only payments staff (and admins) can see amounts.
create table if not exists public.cb_payments (
  payment_id     uuid primary key default gen_random_uuid(),
  entry_id       uuid references public.cb_entries on delete set null,
  member_key     text,
  full_name      text,
  day_id         uuid,
  amount         numeric(8,2),
  status         text not null default 'pending' check (status in ('pending', 'paid')),
  stripe_session text unique,
  stripe_payment text,
  created_at     timestamptz not null default now(),
  paid_at        timestamptz
);
create index if not exists cb_payments_entry_idx on public.cb_payments (entry_id);
alter table public.cb_payments enable row level security;
drop policy if exists "read" on public.cb_payments;
create policy "read" on public.cb_payments for select to authenticated using (public.prep_has_role('payments'));
revoke all on public.cb_payments from anon, authenticated;
grant select on public.cb_payments to authenticated;

-- Staff can mark a front-desk payment, but not undo a card payment (refund it in Stripe)
create or replace function public.cb_set_paid(p_entry uuid, p_paid boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('grading', 'payments') then raise exception 'Only grading or payments staff can change paid.'; end if;
  -- Marking paid goes through Record payment (the "cb" function), which also books them; this only undoes a staff payment
  if p_paid then raise exception 'Use Record payment (refresh the page if you don''t see it): it marks them paid and books them.'; end if;
  if exists (select 1 from cb_payments where entry_id = p_entry and status = 'paid') then
    raise exception 'This was paid by card. Refund it in Stripe if needed.';
  end if;
  update cb_entries set paid = false, paid_at = null, paid_how = null where entry_id = p_entry;
end $$;

-- ---------- Booking sheet: bookings go to a Google Sheet (Apps Script), and a Zap books them from new rows ----------
-- The key the sheet's script checks, so only this app can add bookings (shown in Settings to paste into the script)
alter table public.cb_settings add column if not exists booking_key text not null default replace(gen_random_uuid()::text, '-', '');

-- ---------- Visitors: EFC won't book a member into another school's session ----------
-- A student from another school (e.g. a Marrickville member grading at Concord) is booked here but not sent to the
-- booking sheet; staff see "Book in EFC by hand" until they tick it off.
alter table public.cb_entries add column if not exists efc_by_hand boolean not null default false;
alter table public.cb_entries add column if not exists efc_by_hand_done_at timestamptz;

-- ---------- Bookings close at a set time; late bookings by phone with a new link; receipts ----------
alter table public.cb_days add column if not exists book_by timestamptz;            -- bookings and payments close (null: open until the day)
alter table public.cb_entries add column if not exists late_ok_until timestamptz;  -- a new link issued after closing works until then
alter table public.cb_settings add column if not exists contact_phone text not null default '(02) 9569 1943';
alter table public.cb_payments add column if not exists receipt_url text;          -- Stripe's receipt for a card payment

-- ---------- Automatic emails through GoHighLevel: booking and payment confirmations ----------
alter table public.cb_messages add column if not exists email text;
alter table public.cb_messages drop constraint if exists cb_messages_kind_check;
alter table public.cb_messages add constraint cb_messages_kind_check
  check (kind in ('invite', 'not_booked', 'reminder', 'unpaid', 'congrats', 'retest', 'not_ready', 'photo', 'email_booked', 'email_paid'));
-- What to bring, in the booking and payment emails (one item per line; edit in Settings)
alter table public.cb_settings add column if not exists email_bring text not null default 'Full long-sleeve uniform
Belt
Drink bottle';
