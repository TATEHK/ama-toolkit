-- prep-update-27.sql: grading helpers.
-- Students going for 4th Dan and above help at the black belt grading day (other students can be asked too, with their own wording). Staff choose when to text each one; the text
-- lists the sessions with the fewest helpers (so they fill evenly) ("Reply 1, 2 or 3") and the reply books them in (coloured belt reply webhook,
-- function cb). Each session takes at most 6 helpers. Shown in the Black Belt app: Grading > Helpers.

create table if not exists public.prep_helper_slots (
  slot_id      uuid primary key default gen_random_uuid(),
  cycle_id     uuid not null references public.prep_cycles on delete cascade,
  label        text not null,                 -- how it reads in the text, e.g. "8:00am session"
  grading_date date not null,
  start_time   time,
  cap          int  not null default 6,
  sort         int  not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists prep_helper_slots_cycle_idx on public.prep_helper_slots (cycle_id, sort);

create table if not exists public.prep_helpers (
  cycle_id      uuid not null references public.prep_cycles on delete cascade,
  student_id    text not null references public.prep_students on delete cascade,
  offered_at    timestamptz,                  -- when the helper text went out
  offered_slots uuid[],                       -- the sessions in the order the text numbered them (1, 2, 3 ...)
  slot_id       uuid references public.prep_helper_slots on delete set null,
  confirmed_at  timestamptz,
  declined_at   timestamptz,
  reply_text    text,
  set_by        text,                         -- 'reply', or the staff email when set by hand
  senior        boolean not null default true, -- going for 4th Dan and above: counts towards the 6 per session; other helpers don't
  updated_at    timestamptz not null default now(),
  primary key (cycle_id, student_id)
);
create index if not exists prep_helpers_slot_idx on public.prep_helpers (slot_id);

alter table public.prep_helper_slots enable row level security;
alter table public.prep_helpers      enable row level security;
do $$ declare t text; begin
  foreach t in array array['prep_helper_slots','prep_helpers'] loop
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "write" on public.%I', t);
    execute format('create policy "read" on public.%I for select to authenticated using (public.prep_can_view())', t);
    execute format('create policy "write" on public.%I for all to authenticated using (public.prep_has_role(''grading'', ''calls'')) with check (public.prep_has_role(''grading'', ''calls''))', t);
  end loop;
end $$;

-- Put a helper into a session, never past its cap (two replies at once can't both take the last place).
-- p_balance (text replies): keep the sessions even, so a session can't get ahead of the emptiest one with room by more than 1.
-- Staff setting a session by hand only respect the cap. Returns 'ok', 'full', 'uneven' or 'no_slot'.
drop function if exists public.prep_helper_claim(uuid, text, uuid, text, text);
create or replace function public.prep_helper_claim(p_cycle uuid, p_student text, p_slot uuid, p_reply text default null, p_by text default 'reply', p_balance boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare s public.prep_helper_slots; n int; low int; sen boolean;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and not public.prep_has_role('grading', 'calls') then raise exception 'Not allowed'; end if;
  perform 1 from public.prep_helper_slots where cycle_id = p_cycle order by slot_id for update;   -- one claim at a time per cycle
  select * into s from public.prep_helper_slots where slot_id = p_slot and cycle_id = p_cycle;
  if not found then return 'no_slot'; end if;
  -- Helpers who aren't going for 4th Dan and above don't count towards the cap (or the even split)
  select coalesce((select senior from public.prep_helpers where cycle_id = p_cycle and student_id = p_student), true) into sen;
  select count(*) into n from public.prep_helpers where slot_id = p_slot and student_id <> p_student and senior;
  if sen and n >= s.cap then return 'full'; end if;
  if p_balance and sen then
    select min(c) into low from (
      select (select count(*) from public.prep_helpers h where h.slot_id = x.slot_id and h.student_id <> p_student and h.senior) c, x.cap
      from public.prep_helper_slots x where x.cycle_id = p_cycle) t where c < cap;
    if n > coalesce(low, n) then return 'uneven'; end if;
  end if;
  insert into public.prep_helpers (cycle_id, student_id, slot_id, confirmed_at, declined_at, reply_text, set_by, updated_at)
  values (p_cycle, p_student, p_slot, now(), null, p_reply, p_by, now())
  on conflict (cycle_id, student_id) do update set slot_id = excluded.slot_id, confirmed_at = now(), declined_at = null,
    reply_text = coalesce(excluded.reply_text, public.prep_helpers.reply_text), set_by = excluded.set_by, updated_at = now();
  return 'ok';
end $$;
revoke all on function public.prep_helper_claim(uuid, text, uuid, text, text, boolean) from public, anon;
grant execute on function public.prep_helper_claim(uuid, text, uuid, text, text, boolean) to authenticated, service_role;

-- The December cycle's black belt grading day (Sat 5 Dec, AMA Sydenham): its three session times
insert into public.prep_helper_slots (cycle_id, label, grading_date, start_time, sort)
select c.cycle_id, v.label, date '2026-12-05', v.t::time, v.sort
from public.prep_cycles c, (values ('8:00am session', '08:00', 1), ('12:00pm session', '12:00', 2), ('3:30pm session', '15:30', 3)) v(label, t, sort)
where c.cycle_id = '4a3d13cb-7ec2-494b-b40e-4728c34d8fb5'
  and not exists (select 1 from public.prep_helper_slots x where x.cycle_id = c.cycle_id);
