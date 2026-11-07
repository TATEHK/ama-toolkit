-- AMA Toolkit: coloured belt grading, update 9 (check-in on the day)
-- Run once in Supabase > SQL Editor, after coloured-belts-8.sql. Safe to run again.
-- On the grading day, teachers or grading staff tap each student in on the iPad as they arrive.

alter table public.cb_entries add column if not exists checked_in_at timestamptz;
alter table public.cb_entries add column if not exists checked_in_by text;

-- Check a student in ('in') or undo it ('clear')
create or replace function public.cb_check_in(p_entry uuid, p_state text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('instructor', 'grading') then raise exception 'Only teachers and grading staff can check students in.'; end if;
  if p_state not in ('in', 'clear') then raise exception 'Unknown check-in state.'; end if;
  update cb_entries set
    checked_in_at = case when p_state = 'in' then now() end,
    checked_in_by = case when p_state = 'in' then public.prep_email() end
  where entry_id = p_entry;
  if not found then raise exception 'Student not found on this grading day.'; end if;
end $$;
revoke all on function public.cb_check_in(uuid, text) from public, anon;
grant execute on function public.cb_check_in(uuid, text) to authenticated;

-- An earlier version had a signed sign-off and no-shows: removed
drop function if exists public.cb_sign_off(uuid, text, text);
drop function if exists public.cb_reopen_check_in(uuid);
alter table public.cb_entries drop column if exists no_show;
alter table public.cb_days drop column if exists signed_off_at;
alter table public.cb_days drop column if exists signed_off_by;
alter table public.cb_days drop column if exists signed_off_name;
alter table public.cb_days drop column if exists signed_off_sig;
