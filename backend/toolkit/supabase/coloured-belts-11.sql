-- AMA Toolkit: coloured belt grading, update 11 (invited to Black Belt Club)
-- Run once in Supabase > SQL Editor, after coloured-belts-10.sql. Safe to run again.
-- Teachers mark a student as invited to Black Belt Club when they write them an invitation (usually at a grading).
-- It shows until they join (the nightly EFC update sees them in Black Belt Club) or a teacher clears it.

alter table public.efc_members add column if not exists bbc_invited_at timestamptz;
alter table public.efc_members add column if not exists bbc_invited_by text;

-- Mark (p_on = true) or clear (false) a Black Belt Club invitation
create or replace function public.cb_bbc_invite(p_member text, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.prep_has_role('instructor', 'grading') then raise exception 'Only teachers and grading staff can mark Black Belt Club invitations.'; end if;
  update efc_members set bbc_invited_at = case when p_on then now() end, bbc_invited_by = case when p_on then public.prep_email() end
  where member_key = p_member;
  if not found then raise exception 'Student not found.'; end if;
end $$;
revoke all on function public.cb_bbc_invite(text, boolean) from public, anon;
grant execute on function public.cb_bbc_invite(text, boolean) to authenticated;

-- Students, per program (as in update 10), plus the invitation
create or replace view public.cb_students with (security_invoker = true) as
select m.member_key, g.programme, m.full_name, m.guardian_name,
  coalesce(m.phone, m.guardian_phone) as phone, coalesce(m.email, m.guardian_email) as email,
  m.efc_reference, replace(m.member_key, 'efc:', '') as efc_id, m.location,
  g.belt, b.next_belt, b.next_programme, b.up_belt, b.up_programme, b.sort as belt_sort, b.colour,
  g.promoted_on, (current_date - g.promoted_on) / 7 as weeks_at_belt,
  coalesce(g.attended_since_promoted, 0) as classes, b.classes_needed,
  coalesce(g.attended_since_promoted, 0) >= b.classes_needed as enough_classes,
  b.weeks_between, (current_date - g.promoted_on) / 7 >= b.weeks_between as enough_time,
  case when a.belt = g.belt then a.status end as approval,
  case when a.belt = g.belt then a.note end as approval_note,
  case when a.belt = g.belt then a.decided_by end as decided_by,
  g.updated_at as efc_updated_at,
  m.date_of_birth,
  case when m.date_of_birth ~ '^\d{4}-\d{2}-\d{2}' then extract(year from age(current_date, left(m.date_of_birth, 10)::date))::int end as age,
  coalesce(m.bbc_seen_at > now() - interval '3 days', false) as black_belt_club,
  m.bbc_invited_at, m.bbc_invited_by
from public.efc_grades g
join public.efc_members m on m.member_key = g.member_key
join public.cb_belts b on b.programme = g.programme and b.belt = g.belt
left join public.cb_approvals a on a.member_key = g.member_key and a.programme = g.programme
where m.kind = 'member'
  and m.location = any (array['Marrickville', 'Sydenham', 'Concord', 'West', 'Sylvania']);
revoke all on public.cb_students from anon;
grant select on public.cb_students to authenticated;
