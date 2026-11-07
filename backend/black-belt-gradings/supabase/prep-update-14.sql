-- Black Belt Prep: update 14 (link students to their EFC Aquila record)
-- Run once in Supabase > SQL Editor, after prep-update-13.sql. Safe to run again.
-- Each student can hold their EFC member number (efc_ref, e.g. AU-023-17050). Linked students get the family
-- contact details from EFC filled in where the student record has none. Nothing typed in by staff is overwritten.

alter table public.prep_students add column if not exists efc_ref text;        -- EFC member number
alter table public.prep_students add column if not exists contact_name text;   -- parent or guardian name
create index if not exists prep_students_efc_ref_idx on public.prep_students (efc_ref);

-- Names compared ignoring capitals, spaces and punctuation.
create or replace function public.prep_name_key(p text) returns text
language sql immutable set search_path = public as $$ select lower(regexp_replace(coalesce(p, ''), '[^[:alpha:]]', '', 'g')) $$;

-- Link and fill. p_student null = every student. Links a student with no EFC ref only when exactly one EFC
-- member has the same name, then fills blank phone, email and parent name from the linked EFC record.
-- Returns how many students were newly linked.
create or replace function public.prep_efc_link_run(p_student text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with m as (
    select prep_name_key(full_name) k, min(efc_reference) ref, count(*) c
      from efc_members where kind = 'member' and efc_reference is not null group by 1)
  update prep_students s set efc_ref = m.ref
    from m where m.k = prep_name_key(s.full_name) and m.c = 1 and s.efc_ref is null and not s.is_test
     and (p_student is null or s.student_id = p_student);
  get diagnostics n = row_count;
  update prep_students s set
      contact_phone = coalesce(nullif(s.contact_phone, ''), e.phone, e.guardian_phone),
      contact_email = coalesce(nullif(s.contact_email, ''), e.email, e.guardian_email),
      contact_name  = coalesce(nullif(s.contact_name, ''), e.guardian_name)
    from efc_members e
   where e.efc_reference = s.efc_ref and (p_student is null or s.student_id = p_student)
     and (nullif(s.contact_phone, '') is null or nullif(s.contact_email, '') is null or nullif(s.contact_name, '') is null);
  return n;
end $$;
revoke all on function public.prep_efc_link_run(text) from public, anon, authenticated;

create or replace function public.prep_efc_link(p_student text default null) returns int
language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('admin') then raise exception 'Admins only'; end if;
  return public.prep_efc_link_run(p_student);
end $$;
revoke all on function public.prep_efc_link(text) from public, anon;
grant execute on function public.prep_efc_link(text) to authenticated;

-- New students and name changes link themselves when the match is certain.
create or replace function public.prep_student_efc_auto() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Clearing the EFC ref on purpose leaves the student unlinked.
  if pg_trigger_depth() = 1 and not (tg_op = 'UPDATE' and new.efc_ref is null and old.efc_ref is not null) then
    perform public.prep_efc_link_run(new.student_id);
  end if;
  return null;
end $$;
drop trigger if exists prep_student_efc_auto on public.prep_students;
create trigger prep_student_efc_auto after insert or update of full_name, efc_ref on public.prep_students
  for each row execute function public.prep_student_efc_auto();

-- Which linked refs actually exist in the EFC copy (for the "EFC linked" badge). Refs only, no contact data,
-- so anyone who can see students can see the badge.
create or replace function public.prep_efc_refs() returns setof text
language sql stable security definer set search_path = public as $$
  select s.efc_ref from prep_students s
   where s.efc_ref is not null and public.prep_can_view()
     and exists (select 1 from efc_members e where e.efc_reference = s.efc_ref)
$$;
revoke all on function public.prep_efc_refs() from public, anon;
grant execute on function public.prep_efc_refs() to authenticated;
