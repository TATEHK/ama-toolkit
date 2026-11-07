-- Black Belt Prep: update 09 (classes attended)
-- Run once in Supabase > SQL Editor, after prep-update-08.sql. Safe to run again.
-- Records how many regular classes each student has attended during a preparation cycle (a number,
-- separate from the prep session attendance), and optionally how many classes the cycle requires.

alter table public.prep_enrolments add column if not exists classes_attended   int not null default 0;
alter table public.prep_enrolments add column if not exists classes_updated_at timestamptz;
alter table public.prep_enrolments add column if not exists classes_updated_by text;
alter table public.prep_enrolments drop constraint if exists prep_enrolments_classes_check;
alter table public.prep_enrolments add constraint prep_enrolments_classes_check check (classes_attended between 0 and 999);

-- Classes required in the cycle (empty: no minimum)
alter table public.prep_cycles add column if not exists classes_required int;
alter table public.prep_cycles drop constraint if exists prep_cycles_classes_required_check;
alter table public.prep_cycles add constraint prep_cycles_classes_required_check check (classes_required is null or classes_required between 1 and 999);

-- Instructors and attendance takers record the counts (enrolments are otherwise changed by admins only)
create or replace function public.prep_set_classes(p_cycle uuid, p_student text, p_count int)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.prep_has_role('instructor', 'attendance') then
    raise exception 'Your login cannot record classes.' using errcode = '42501';
  end if;
  if p_count is null or p_count < 0 or p_count > 999 then raise exception 'Classes attended must be between 0 and 999.'; end if;
  update public.prep_enrolments
     set classes_attended = p_count, classes_updated_at = now(), classes_updated_by = public.prep_email()
   where cycle_id = p_cycle and student_id = p_student
  returning classes_attended into n;
  if n is null then raise exception 'That student is not in this cycle.'; end if;
  return n;
end $$;
revoke all on function public.prep_set_classes(uuid, text, int) from public, anon;
grant execute on function public.prep_set_classes(uuid, text, int) to authenticated;

-- Classes needed for each belt (the belt being graded to). A belt with no number set uses the
-- cycle's "classes required", if any.
create table if not exists public.prep_class_requirements (
  target_rank text primary key,
  classes     int not null check (classes between 1 and 999),
  updated_at  timestamptz not null default now()
);
alter table public.prep_class_requirements enable row level security;
drop policy if exists "read" on public.prep_class_requirements;
drop policy if exists "write" on public.prep_class_requirements;
create policy "read"  on public.prep_class_requirements for select to authenticated using (public.prep_can_view());
create policy "write" on public.prep_class_requirements for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
grant select, insert, update, delete on public.prep_class_requirements to authenticated;
drop trigger if exists prep_class_requirements_audit on public.prep_class_requirements;
create trigger prep_class_requirements_audit after insert or update or delete on public.prep_class_requirements
  for each row execute function public.prep_audit('target_rank');
