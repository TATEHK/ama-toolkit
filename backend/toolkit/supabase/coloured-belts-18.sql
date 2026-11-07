-- AMA Toolkit: coloured belt grading, update 18 (black belt gradings reuse the booking/payment flow)
-- Run once in Supabase > SQL Editor, after coloured-belts-17.sql. Safe to run again.
--
-- Black belt (Dan) gradings now use the same cb pipeline as coloured belts: a booking link, pay by card,
-- auto-book the EFC session, branded emails, and the follow-up texts. A black belt grading day is a cb_day
-- with bb = true, linked to a Black Belt Prep cycle (prep_cycle_id) and the Dan ranks it is for (the existing
-- cb_days.belts array). Candidates are the prep grading students of those ranks, matched to their EFC member
-- record by efc_ref. The grading fee comes from the prep grading fee rates (prep_grading_fee_rates), by the
-- rank they are grading to. (Payments are tracked in cb like coloured belts; writing them back to the prep
-- payment records is a separate step.)

-- A black belt grading day, and which prep cycle it draws candidates from
alter table public.cb_days add column if not exists bb boolean not null default false;
alter table public.cb_days add column if not exists prep_cycle_id uuid;

-- Normalise an EFC Dan belt name ("Black Belt: Third Dan Level 3") to the prep rank naming ("3rd Dan Level 3"),
-- so prep_next_belt and the prep grading fee rates line up.
create or replace function public.cb_dan_rank(efc_belt text) returns text
language plpgsql immutable as $$
declare r text; w text; num text;
begin
  r := btrim(coalesce(efc_belt, ''));
  if r = '' then return null; end if;
  r := regexp_replace(r, '^\s*black belt\s*:\s*', '', 'i');          -- drop the "Black Belt:" prefix
  if lower(r) = 'cho dan bo' then return 'Cho Dan Bo'; end if;
  if lower(r) = 'probationary black belt' then return 'Probationary Black Belt'; end if;
  if lower(r) = 'first dan' then return '1st Dan Black Belt'; end if; -- prep's name for a plain 1st Dan
  w := lower(split_part(r, ' ', 1));
  num := case w when 'first' then '1st' when 'second' then '2nd' when 'third' then '3rd'
                when 'fourth' then '4th' when 'fifth' then '5th' when 'sixth' then '6th'
                when 'seventh' then '7th' when 'eighth' then '8th' when 'ninth' then '9th' else null end;
  if num is null then return r; end if;                              -- already numeric or unknown: leave as-is
  return num || substr(r, length(split_part(r, ' ', 1)) + 1);        -- replace the first word with 1st/2nd/...
end $$;
revoke all on function public.cb_dan_rank(text) from public, anon;
grant execute on function public.cb_dan_rank(text) to authenticated;

-- Add the prep grading students for a black belt session as cb entries (so they get booking links), skipping any
-- already added. Matches prep students to their EFC member by efc_ref, and only those whose grading-to rank is one
-- of the day's ranks. Returns how many were newly added.
create or replace function public.cb_bb_sync(p_day uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare d public.cb_days%rowtype; added int := 0;
begin
  if not (public.prep_has_role('admin') or public.prep_has_role('grading')) then
    raise exception 'Your login cannot manage black belt bookings.' using errcode = '42501';
  end if;
  select * into d from public.cb_days where day_id = p_day and bb;
  if not found then raise exception 'That is not a black belt grading session.'; end if;
  if d.prep_cycle_id is null then raise exception 'This session is not linked to a black belt prep cycle.'; end if;
  with cand as (
    select em.member_key, ps.full_name, ps.belt_rank as belt_from, public.prep_next_belt(ps.belt_rank) as belt_to
      from public.prep_enrolments e
      join public.prep_students ps on ps.student_id = e.student_id
      join public.efc_members em on em.efc_reference = ps.efc_ref
     where e.cycle_id = d.prep_cycle_id and e.is_grading and ps.efc_ref is not null
       and (d.belts is null or public.prep_next_belt(ps.belt_rank) = any (d.belts))
  ), ins as (
    insert into public.cb_entries (day_id, member_key, full_name, belt_from, belt_to)
    select p_day, member_key, full_name, belt_from, belt_to from cand
    on conflict (day_id, member_key) do nothing
    returning 1
  )
  select count(*) into added from ins;
  return added;
end $$;
revoke all on function public.cb_bb_sync(uuid) from public, anon;
grant execute on function public.cb_bb_sync(uuid) to authenticated;
