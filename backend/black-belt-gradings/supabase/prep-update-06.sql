-- Black Belt Prep: update 06 (link ID cards to students)
-- Run once in Supabase > SQL Editor, after prep-update-05.sql. Safe to run again.
-- Card records in AMA ID Cards are linked to prep students by name, so the prep app can show when a
-- student's ID card has been printed. A card is linked only when its name matches exactly one student
-- (and that student has no other card), ignoring capitals, spaces and punctuation. Nothing else about
-- the card software changes: its people get a Student ID filled in.

create or replace function public.prep_norm_name(t text) returns text
  language sql immutable as $$ select regexp_replace(lower(coalesce(t, '')), '[^a-z]', '', 'g') $$;

-- The one student a card name belongs to, or null if none or more than one
create or replace function public.prep_student_for_card_name(p_name text) returns text
  language sql stable security definer set search_path = public as $$
  select min(s.student_id) from public.prep_students s
  where public.prep_norm_name(p_name) <> ''
    and public.prep_norm_name(p_name) in (public.prep_norm_name(s.full_name), public.prep_norm_name(s.certificate_name))
    and not exists (select 1 from public.people p where p.student_id = s.student_id)
  having count(*) = 1
$$;

-- Link every unlinked card whose name matches exactly one unlinked student (and no other card has that name)
create or replace function public.prep_link_cards() returns int
  language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; sid text;
begin
  for r in
    select p.id, p.name from public.people p
    where p.student_id is null
      and (select count(*) from public.people q where q.student_id is null and public.prep_norm_name(q.name) = public.prep_norm_name(p.name)) = 1
  loop
    sid := public.prep_student_for_card_name(r.name);
    if sid is not null then
      update public.people set student_id = sid where id = r.id and student_id is null;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
grant execute on function public.prep_link_cards() to authenticated;

-- New or renamed cards in the card software link themselves
create or replace function public.prep_people_link() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.student_id is null and (tg_op = 'INSERT' or new.name is distinct from old.name)
     and not exists (select 1 from public.people q where q.id <> new.id and q.student_id is null
                     and public.prep_norm_name(q.name) = public.prep_norm_name(new.name)) then
    new.student_id := public.prep_student_for_card_name(new.name);
  end if;
  return new;
end $$;
drop trigger if exists prep_people_link on public.people;
create trigger prep_people_link before insert or update of name on public.people
  for each row execute function public.prep_people_link();

-- New or renamed students link to an existing card
create or replace function public.prep_student_link_card() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or (new.full_name, new.certificate_name) is distinct from (old.full_name, old.certificate_name) then
    perform public.prep_link_cards();
  end if;
  return new;
end $$;
drop trigger if exists prep_student_link_card on public.prep_students;
create trigger prep_student_link_card after insert or update of full_name, certificate_name on public.prep_students
  for each row execute function public.prep_student_link_card();

-- Unlinked cards an admin can link by hand (names only, no photos or dates)
create or replace function public.prep_unlinked_cards()
returns table (person_id uuid, name text, dan text, printed_at timestamptz)
  language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.dan, p.printed_at from public.people p
  where p.student_id is null and public.prep_has_role('idcards')
  order by p.name
$$;
grant execute on function public.prep_unlinked_cards() to authenticated;

-- Link or unlink one card by hand
create or replace function public.prep_set_card_link(p_student text, p_person uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('idcards') then raise exception 'You do not have permission to link ID cards.'; end if;
  update public.people set student_id = null where student_id = p_student;
  if p_person is not null then
    update public.people set student_id = p_student where id = p_person and student_id is null;
    if not found then raise exception 'That card is already linked to another student.'; end if;
  end if;
end $$;
grant execute on function public.prep_set_card_link(text, uuid) to authenticated;

-- Link existing cards now
select public.prep_link_cards();
