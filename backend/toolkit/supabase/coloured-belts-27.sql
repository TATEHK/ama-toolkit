-- AMA Toolkit: coloured belts update 27. A student's Taekwondo grade on efc_members is never replaced by another programme's.
--
-- efc_members.belt / promoted_on / attended_since_promoted hold the Taekwondo grade (Black Belt Gradings, the hub's grading
-- card and the black belt booking use it). The EFC Assessment update sends one row per programme, and on 8 Nov 2026 the last
-- programme sent won: 568 students showed their Black Belt Club ("Entry Level"), Little Dragons or other grade instead.
-- efc_grades keeps every programme's grade correctly, so the Taekwondo one is copied back from there.

-- 1) An update for another programme leaves the Taekwondo grade alone (it is still saved in efc_grades by its own path)
create or replace function public.efc_members_keep_known()
returns trigger language plpgsql as $$
begin
  new.location       := coalesce(nullif(btrim(new.location), ''), old.location);
  new.status         := coalesce(nullif(btrim(new.status), ''), old.status);
  new.guardian_name  := coalesce(new.guardian_name, old.guardian_name);
  new.guardian_phone := coalesce(new.guardian_phone, old.guardian_phone);
  new.guardian_email := coalesce(new.guardian_email, old.guardian_email);
  new.efc_reference  := coalesce(new.efc_reference, old.efc_reference);
  new.date_of_birth  := coalesce(new.date_of_birth, old.date_of_birth);
  if new.programme is distinct from 'Taekwondo'
     and (old.programme = 'Taekwondo' or exists (select 1 from public.efc_grades g where g.member_key = old.member_key and g.programme = 'Taekwondo')) then
    new.programme := old.programme; new.belt := old.belt; new.promoted_on := old.promoted_on;
    new.attended_since_promoted := old.attended_since_promoted; new.ready_to_promote := old.ready_to_promote;
  end if;
  return new;
end $$;

-- 2) Put the Taekwondo grade back for everyone it was replaced for
update public.efc_members m set programme = 'Taekwondo', belt = g.belt, promoted_on = g.promoted_on, attended_since_promoted = g.attended_since_promoted
  from public.efc_grades g
 where g.member_key = m.member_key and g.programme = 'Taekwondo' and m.programme is distinct from 'Taekwondo';
