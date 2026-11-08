-- AMA Toolkit: coloured belts update 25. Black belt gradings run at each student's own school.
--
-- A black belt day (cb_days.bb) is one date with a session at every school. Each entry now carries the student's
-- home school (cb_entries.school), so the booking goes to their own school's EFC session and the texts, emails and
-- booking page name their own school, not the day's (Sydenham).
--
-- The school comes from EFC (efc_members.location), or failing that from the EFC reference, whose middle part is the
-- school: AU-023 Marrickville, AU-256 Sydenham, AU-257 West, AU-258 Concord, AU-3096 Sylvania.

create or replace function public.efc_school(p_member text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(m.location), ''),
    case split_part(m.efc_reference, '-', 2)
      when '023' then 'Marrickville' when '256' then 'Sydenham' when '257' then 'West'
      when '258' then 'Concord' when '3096' then 'Sylvania' end)
  from efc_members m where m.member_key = p_member
$$;

alter table public.cb_entries add column if not exists school text;

create or replace function public.cb_entries_school()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.school is null then new.school := public.efc_school(new.member_key); end if;
  return new;
end $$;
drop trigger if exists cb_entries_school on public.cb_entries;
create trigger cb_entries_school before insert on public.cb_entries
  for each row execute function public.cb_entries_school();

update public.cb_entries set school = public.efc_school(member_key) where school is null;
