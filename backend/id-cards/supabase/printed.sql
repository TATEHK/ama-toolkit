-- AMA ID Cards: remember who has been printed
-- Run once in Supabase > SQL Editor (after setup.sql). Safe to run again.
--
-- When the print station finishes a job, everyone on it is marked as printed.
-- If someone's card details change afterwards (name, date of birth, dan, issued date or photo),
-- the mark is cleared so they show up again as needing a new card.

alter table public.people     add column if not exists printed_at timestamptz;
alter table public.print_jobs add column if not exists people_ids uuid[] not null default '{}';

-- Job printed: mark everyone on it
create or replace function public.mark_people_printed() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'printed' and old.status is distinct from 'printed' and coalesce(array_length(new.people_ids, 1), 0) > 0 then
    update public.people set printed_at = coalesce(new.printed_at, now()) where id = any(new.people_ids);
  end if;
  return new;
end $$;
drop trigger if exists print_jobs_mark_printed on public.print_jobs;
create trigger print_jobs_mark_printed
  after update of status on public.print_jobs
  for each row execute function public.mark_people_printed();

-- Card details changed after printing: they need a new card
create or replace function public.clear_printed_on_change() returns trigger
  language plpgsql
as $$
begin
  if old.printed_at is not null
     and new.printed_at is not distinct from old.printed_at
     and (new.name, new.dob, new.dan, new.issued, new.photo_path)
         is distinct from (old.name, old.dob, old.dan, old.issued, old.photo_path) then
    new.printed_at := null;
  end if;
  return new;
end $$;
drop trigger if exists people_clear_printed on public.people;
create trigger people_clear_printed
  before update on public.people
  for each row execute function public.clear_printed_on_change();
