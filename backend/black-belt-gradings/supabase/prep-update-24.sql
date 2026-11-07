-- prep-update-24: grading status for the AMA Hub family view.
--
-- hub_family_grading(names, mobile, email) finds the students in a hub family (by the family's mobile or email
-- in EFC or the black belt list, or by a student's exact full name) and returns, for each one:
--   the belt they are going for, whether the grading invite has gone out (and booked / paid), classes done on
--   the belt against classes needed, and for black belt candidates the essay and the ID card.
--
-- Only the "hub" Edge Function calls this (service role), after the hub has confirmed the staff member's
-- hub sign-in. Nobody signed in to the apps and nobody anonymous can run it.
-- Safe to run more than once.

create or replace function public.hub_last9(v text) returns text
language sql immutable as $$ select right(regexp_replace(coalesce(v, ''), '\D', '', 'g'), 9) $$;

create or replace function public.hub_name(v text) returns text
language sql immutable as $$ select lower(regexp_replace(btrim(coalesce(v, '')), '\s+', ' ', 'g')) $$;

create or replace function public.hub_family_grading(p_names text[], p_mobile text, p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  m9 text := hub_last9(p_mobile);
  em text := lower(btrim(coalesce(p_email, '')));
  nm text[] := array(select hub_name(x) from unnest(coalesce(p_names, '{}'::text[])) x where hub_name(x) <> '');
  out jsonb := '[]'::jsonb;
  r record;
begin
  if length(m9) < 9 then m9 := null; end if;
  if em = '' or position('@' in em) = 0 then em := null; end if;
  if m9 is null and em is null and coalesce(array_length(nm, 1), 0) = 0 then return out; end if;

  for r in
    with efc as (
      select m.member_key, m.full_name, m.efc_reference, m.belt, m.attended_since_promoted
        from efc_members m
       where (m9 is not null and m9 in (hub_last9(m.phone), hub_last9(m.guardian_phone)))
          or (em is not null and em in (lower(btrim(coalesce(m.email, ''))), lower(btrim(coalesce(m.guardian_email, '')))))
          or hub_name(m.full_name) = any(nm)
    ),
    bb as (
      select p.student_id, p.full_name, p.efc_ref, p.belt_rank
        from prep_students p
       where p.is_active and not p.is_test
         and ((m9 is not null and m9 = hub_last9(p.contact_phone))
           or (em is not null and em = lower(btrim(coalesce(p.contact_email, ''))))
           or hub_name(p.full_name) = any(nm)
           or p.efc_ref in (select efc_reference from efc where efc_reference is not null))
    ),
    people as (
      -- one row per person: EFC member, black belt student, or both (joined on the EFC reference)
      select coalesce(e.full_name, b.full_name) as name, e.member_key, e.belt as efc_belt, e.attended_since_promoted,
             b.student_id, b.belt_rank
        from efc e full join bb b on b.efc_ref = e.efc_reference
    )
    select * from people order by name
  loop
    declare
      cb record; ent record; g record; enr record; es record; card record;
      item jsonb; need int; essay_needed boolean; card_status text; printed timestamptz;
    begin
      -- Every lookup runs (a missing key simply finds nothing), so each record always has its fields.
      -- Black belt grading in an active cycle
        select gr.target_rank, gr.current_rank, gr.eligibility_decision, gr.status, gr.result, gr.cycle_id,
               coalesce(gr.grading_date, c.grading_date) as grading_date, c.classes_required, c.name as cycle_name
          into g
          from prep_grading gr join prep_cycles c on c.cycle_id = gr.cycle_id
         where gr.student_id = r.student_id and c.status = 'active'
           and coalesce(gr.eligibility_decision, '') <> 'not_eligible'
         order by coalesce(gr.grading_date, c.grading_date) desc nulls last, gr.created_at desc
         limit 1;
        select e.classes_attended, e.is_grading into enr from prep_enrolments e
         where e.cycle_id = g.cycle_id and e.student_id = r.student_id;

      -- Coloured belt record and the latest grading invite (black belt invites go through the same bookings)
        select s.programme, s.belt, s.next_belt, s.classes, s.classes_needed, s.approval
          into cb from cb_students s where s.member_key = r.member_key
         order by s.belt_sort desc nulls last limit 1;
        select e.belt_from, e.belt_to, e.invited_at, e.booked_at, e.paid, e.result, d.grading_date, d.location, d.bb
          into ent
          from cb_entries e join cb_days d on d.day_id = e.day_id
         where e.member_key = r.member_key and d.grading_date >= current_date - 14
           -- a black belt booking only counts alongside an active black belt grading (checked below)
           and (not coalesce(d.bb, false) or g.target_rank is not null)
         order by d.grading_date desc, e.created_at desc limit 1;
        select x.status, x.submitted_at, x.mark, x.late_ok into es from prep_essays x
         where x.cycle_id = g.cycle_id and x.student_id = r.student_id
         order by x.version desc nulls last, x.created_at desc limit 1;
        select s.status, s.printed_at into card from prep_id_card_status s where s.student_id = r.student_id limit 1;

      if g.target_rank is not null then
        need := coalesce((select classes from prep_class_requirements where target_rank = g.target_rank),
                         g.classes_required, (select sessions_required from prep_settings where id = 1));
        essay_needed := exists (select 1 from prep_essay_questions q where q.target_rank = g.target_rank) or es.status is not null;
        if card.status is not null then
          card_status := card.status; printed := card.printed_at;
        else
          select max(cp.printed_at) into printed from prep_card_people() cp where cp.student_id = r.student_id;
          card_status := case when printed is not null then 'printed' else 'not_printed' end;
        end if;

        item := jsonb_build_object(
          'name', r.name, 'track', 'black',
          'belt', coalesce(g.current_rank, r.belt_rank, r.efc_belt),
          'target', g.target_rank,
          'grading_date', coalesce(ent.grading_date, g.grading_date),
          'decision', g.eligibility_decision,
          'result', coalesce(g.result, ent.result),
          'invite', jsonb_build_object('sent', ent.invited_at is not null or coalesce(enr.is_grading, false),
                                       'at', ent.invited_at, 'booked', ent.booked_at is not null, 'paid', coalesce(ent.paid, false)),
          -- classes on the belt: EFC's count since the last promotion, or the number entered in Black Belt Gradings if higher
          'classes', jsonb_build_object('done', greatest(coalesce(enr.classes_attended, 0), coalesce(r.attended_since_promoted, 0)), 'needed', need),
          'essay', jsonb_build_object('needed', essay_needed,
                                      'status', case when es.status = 'submitted' then 'submitted' when essay_needed then 'not_submitted' end,
                                      'at', es.submitted_at, 'mark', es.mark),
          'id_card', jsonb_build_object('needed', card_status <> 'not_required', 'status', card_status, 'printed', printed is not null, 'at', printed));
      elsif cb.belt is not null or ent.belt_to is not null then
        item := jsonb_build_object(
          'name', r.name, 'track', 'coloured',
          'belt', coalesce(ent.belt_from, cb.belt, r.efc_belt),
          'target', coalesce(ent.belt_to, cb.next_belt),
          'grading_date', ent.grading_date,
          'decision', cb.approval,
          'result', ent.result,
          'invite', jsonb_build_object('sent', ent.invited_at is not null, 'at', ent.invited_at,
                                       'booked', ent.booked_at is not null, 'paid', coalesce(ent.paid, false)),
          'classes', jsonb_build_object('done', coalesce(cb.classes, r.attended_since_promoted, 0), 'needed', cb.classes_needed),
          'essay', jsonb_build_object('needed', false),
          'id_card', jsonb_build_object('needed', false));
      else
        continue;
      end if;
      out := out || jsonb_build_array(item);
    end;
  end loop;
  return out;
end $$;

revoke all on function public.hub_family_grading(text[], text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.hub_family_grading(text[], text, text) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.hub_family_grading(text[], text, text) to service_role';
  end if;
end $$;
