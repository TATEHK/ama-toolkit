-- AMA Toolkit: coloured belts update 24. Keep each student's school when EFC sends an update without one.
--
-- The morning EFC Assessment update (the "efc" function) sends no school (location) or status, and its upsert was
-- blanking them. cb_students only lists members at the five schools, so on Sun 8 Nov 2026 the coloured belt student
-- list dropped from ~1,700 to 17.

-- 1) An update that sends nothing for these fields keeps what we already know
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
  return new;
end $$;
drop trigger if exists efc_members_keep_known on public.efc_members;
create trigger efc_members_keep_known before update on public.efc_members
  for each row execute function public.efc_members_keep_known();

-- 2) Put the schools back from the 8 Nov morning run, which went school by school in this order (times in UTC)
update public.efc_members set location = case
    when updated_at <  '2026-11-07 21:49:15+00' then 'Marrickville'
    when updated_at <  '2026-11-07 21:49:30+00' then 'Sydenham'
    when updated_at <  '2026-11-07 21:49:40+00' then 'Concord'
    when updated_at <  '2026-11-07 21:49:50+00' then 'West'
    else 'Sylvania' end,
  status = coalesce(status, 'Enrolled')
where location is null and updated_at between '2026-11-07 21:46:00+00' and '2026-11-07 21:50:30+00';
