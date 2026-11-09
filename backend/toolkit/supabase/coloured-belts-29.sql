-- Coloured belts 29: replies that fix the belt, and "not grading" calls for admins (cb function, reply action).
-- Run once in Supabase > SQL Editor, after coloured-belts-28.sql. Safe to run again.
--   "That's the wrong belt, she's going for Green": the entry's belt is changed (and the day, if that grading isn't for the
--   new belt), belt_changed_from keeps what it was, and the family is texted the booking link (kind 'belt_fix').
--   "We don't want to grade": a 'not_grading' call, for_admin, on the hub's call list (cb_calls_due), for an admin to follow up.

alter table public.cb_entries add column if not exists belt_changed_from text;   -- e.g. "Brown Belt to Red Belt", when a family's reply changed it
alter table public.cb_entries add column if not exists belt_changed_at timestamptz;
alter table public.cb_calls add column if not exists for_admin boolean not null default false;

alter table public.cb_calls drop constraint if exists cb_calls_reason_check;
alter table public.cb_calls add constraint cb_calls_reason_check check (reason in ('not_booked', 'concern', 'not_grading'));

alter table public.cb_messages drop constraint if exists cb_messages_kind_check;
alter table public.cb_messages add constraint cb_messages_kind_check check (kind in ('invite', 'not_booked', 'reminder', 'unpaid', 'congrats', 'retest',
  'not_ready', 'photo', 'email_booked', 'email_paid', 'bbc_followup', 'seq', 'seq_test', 'sms_backup', 'alt_offer', 'belt_fix'));

-- The hub's call list: same as before, plus for_admin (a "not grading" reply, for an admin rather than the rostered staff)
drop function if exists public.cb_calls_due(text);
create function public.cb_calls_due(p_key text)
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
     and not c.done and not coalesce(e.paid, false) and e.result is null and not d.closed and e.seq_stopped_at is null
     and (c.callback_on is null or c.callback_on <= (now() at time zone 'Australia/Sydney')::date)
   order by c.for_admin desc, d.grading_date, e.full_name;
$$;
revoke all on function public.cb_calls_due(text) from public;
grant execute on function public.cb_calls_due(text) to anon, authenticated;
