-- AMA Toolkit: coloured belt grading, update 10 (who is in Black Belt Club)
-- Run once in Supabase > SQL Editor, after coloured-belts-9.sql. Safe to run again.
-- The nightly EFC update also pulls everyone enrolled in EFC's "Black Belt Club" program. Each student it finds is stamped
-- with the time; anyone seen in the last 3 days counts as a member (so one missed night doesn't drop anyone, and someone who
-- leaves the club drops off within a few days). Only membership is kept: no payment or balance details.

alter table public.efc_members add column if not exists bbc_seen_at timestamptz;

-- The nightly update: these EFC member IDs are in Black Belt Club now
create or replace function public.cb_bbc_seen(p_ids text[])
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update efc_members set bbc_seen_at = now() where member_key = any (select 'efc:' || x from unnest(p_ids) x);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.cb_bbc_seen(text[]) from public, anon, authenticated;

-- Students, per program (as in update 3), plus black_belt_club
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
  coalesce(m.bbc_seen_at > now() - interval '3 days', false) as black_belt_club
from public.efc_grades g
join public.efc_members m on m.member_key = g.member_key
join public.cb_belts b on b.programme = g.programme and b.belt = g.belt
left join public.cb_approvals a on a.member_key = g.member_key and a.programme = g.programme
where m.kind = 'member'
  and m.location = any (array['Marrickville', 'Sydenham', 'Concord', 'West', 'Sylvania']);
revoke all on public.cb_students from anon;
grant select on public.cb_students to authenticated;
