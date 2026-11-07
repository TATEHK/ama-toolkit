-- Black Belt Prep: update 02
-- Run once in Supabase > SQL Editor, after prep-update-01.sql. Safe to run again.
-- Dan numbers now run separately for each rank being graded for: Probationary Black Belt,
-- 1st Dan Black Belt, 2nd Dan, 3rd Dan, 4th Dan and 5th Dan each have their own next number,
-- set in the app under More > Settings. Numbers already handed out are kept.

-- One "next number" per rank
create table if not exists public.prep_dan_counters (
  target_rank text primary key check (target_rank in
              ('Probationary Black Belt','1st Dan Black Belt','2nd Dan','3rd Dan','4th Dan','5th Dan')),
  next_number int not null check (next_number > 0),
  updated_at  timestamptz not null default now()
);

-- If a single starting number was set before, each rank starts from it (change them in Settings)
insert into public.prep_dan_counters (target_rank, next_number)
  select t, s.next_dan_number
  from unnest(array['Probationary Black Belt','1st Dan Black Belt','2nd Dan','3rd Dan','4th Dan','5th Dan']) t
  cross join public.prep_settings s
  where s.id = 1 and s.next_dan_number is not null
  on conflict do nothing;

-- The same number may now be used once per rank (e.g. Probationary 501 and 1st Dan 501)
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'prep_dan_numbers_pkey'
             and conrelid = 'public.prep_dan_numbers'::regclass and array_length(conkey, 1) = 1) then
    alter table public.prep_dan_numbers drop constraint prep_dan_numbers_pkey;
    alter table public.prep_dan_numbers add constraint prep_dan_numbers_pkey primary key (target_rank, dan_number);
  end if;
end $$;

-- Give one student their Dan number for their next rank (or return the one they already have).
-- Returns null when they are not going for a Dan, or that rank has no next number set.
create or replace function public.prep_assign_dan_number(p_student text, p_cycle uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare target text; n int;
begin
  select public.prep_dan_target(belt_rank) into target from public.prep_students where student_id = p_student and is_active;
  if target is null then return null; end if;
  select dan_number into n from public.prep_dan_numbers where student_id = p_student and target_rank = target;
  if n is not null then return n; end if;
  loop
    update public.prep_dan_counters set next_number = next_number + 1, updated_at = now()
      where target_rank = target
      returning next_number - 1 into n;
    if n is null then return null; end if;                       -- no next number for this rank
    exit when not exists (select 1 from public.prep_dan_numbers where target_rank = target and dan_number = n);
  end loop;
  insert into public.prep_dan_numbers (dan_number, student_id, target_rank, cycle_id, assigned_by)
    values (n, p_student, target, p_cycle, public.prep_email());
  return n;
end $$;
revoke all on function public.prep_assign_dan_number(text, uuid) from public, anon, authenticated;

-- Everyone in a cycle who should have a Dan number but doesn't, in name order.
-- Ranks with no next number set are left for later. Returns how many were given numbers.
create or replace function public.prep_assign_missing_dan_numbers(p_cycle uuid)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not public.prep_has_role('admin') then raise exception 'Only an admin can assign Dan numbers.'; end if;
  for r in
    select s.student_id from public.prep_enrolments e join public.prep_students s using (student_id)
    where e.cycle_id = p_cycle and s.is_active and public.prep_dan_target(s.belt_rank) is not null
      and exists (select 1 from public.prep_dan_counters c where c.target_rank = public.prep_dan_target(s.belt_rank))
      and not exists (select 1 from public.prep_dan_numbers d where d.student_id = s.student_id and d.target_rank = public.prep_dan_target(s.belt_rank))
    order by s.full_name, s.student_id
  loop
    perform public.prep_assign_dan_number(r.student_id, p_cycle);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function public.prep_assign_missing_dan_numbers(uuid) to authenticated;

-- Security: everyone with a prep role can see the next numbers; admins set them
alter table public.prep_dan_counters enable row level security;
drop policy if exists "read" on public.prep_dan_counters;
drop policy if exists "write" on public.prep_dan_counters;
create policy "read"  on public.prep_dan_counters for select to authenticated using (public.prep_can_view());
create policy "write" on public.prep_dan_counters for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));

drop trigger if exists prep_dan_counters_audit on public.prep_dan_counters;
create trigger prep_dan_counters_audit after insert or update or delete on public.prep_dan_counters
  for each row execute function public.prep_audit('target_rank');
