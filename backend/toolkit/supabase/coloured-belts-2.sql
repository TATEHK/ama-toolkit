-- Coloured belt grading, update 2: age on Who's ready, and importing an EFC list from the app.
-- Run once in the Supabase SQL Editor (after coloured-belts.sql). Safe to run again.

-- 1. Date of birth and age on each student (added at the end so the view can be replaced in place)
create or replace view public.cb_students with (security_invoker = true) as
select m.member_key, m.full_name, m.guardian_name,
  coalesce(m.phone, m.guardian_phone) as phone, coalesce(m.email, m.guardian_email) as email,
  m.efc_reference, replace(m.member_key, 'efc:', '') as efc_id, m.location, m.belt, b.next_belt, b.sort as belt_sort, b.colour,
  m.promoted_on, (current_date - m.promoted_on) / 7 as weeks_at_belt,
  coalesce(m.attended_since_promoted, 0) as classes, b.classes_needed,
  coalesce(m.attended_since_promoted, 0) >= b.classes_needed as enough_classes,
  b.weeks_between, (current_date - m.promoted_on) / 7 >= b.weeks_between as enough_time,
  case when a.belt = m.belt then a.status end as approval,
  case when a.belt = m.belt then a.note end as approval_note,
  case when a.belt = m.belt then a.decided_by end as decided_by,
  m.updated_at as efc_updated_at,
  m.date_of_birth,
  case when m.date_of_birth ~ '^\d{4}-\d{2}-\d{2}' then extract(year from age(current_date, left(m.date_of_birth, 10)::date))::int end as age
from public.efc_members m
join public.cb_belts b on b.belt = m.belt
left join public.cb_approvals a on a.member_key = m.member_key
where m.kind = 'member' and m.programme = 'Taekwondo'
  and m.location = any (array['Marrickville', 'Sydenham', 'Concord', 'West', 'Sylvania']);

-- 2. Import an EFC list (CSV or Excel read in the browser, sent here as JSON rows). Grading staff and admins only.
-- Each row may have: member_id, reference, full_name, first_name, last_name, dob, belt, location, phone, email,
-- guardian_name, programme, status, promoted_on, classes (since last grading), attendance_total, last_attended.
-- A row matches a student by EFC member ID, then EFC reference, then name + date of birth. Blank cells leave what's there.
-- Medical notes and balances are never stored.
create or replace function public.cb_import_efc(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; k text; mid text; ref text; nm text; dob date; n_up int := 0; n_add int := 0; n_skip int := 0;
  t text := 'efc import';
  v_promoted date; v_last date; v_classes int; v_total int;
begin
  if not public.prep_has_role('grading') then raise exception 'Only grading staff can import EFC lists.'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Expected a list of rows.'; end if;
  if jsonb_array_length(p_rows) > 6000 then raise exception 'Too many rows at once (6000 at most).'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    mid := nullif(btrim(r->>'member_id'), '');
    ref := nullif(btrim(r->>'reference'), '');
    nm := nullif(btrim(coalesce(nullif(btrim(r->>'full_name'), ''), concat_ws(' ', nullif(btrim(r->>'first_name'), ''), nullif(btrim(r->>'last_name'), '')))), '');
    begin dob := nullif(r->>'dob', '')::date; exception when others then dob := null; end;
    begin v_promoted := nullif(r->>'promoted_on', '')::date; exception when others then v_promoted := null; end;
    begin v_last := nullif(r->>'last_attended', '')::date; exception when others then v_last := null; end;
    begin v_classes := nullif(r->>'classes', '')::numeric::int; exception when others then v_classes := null; end;
    begin v_total := nullif(r->>'attendance_total', '')::numeric::int; exception when others then v_total := null; end;
    k := null;
    if mid is not null then select member_key into k from efc_members where member_key = 'efc:' || mid; end if;
    if k is null and ref is not null then select member_key into k from efc_members where efc_reference = ref limit 1; end if;
    if k is null and nm is not null and dob is not null then
      select member_key into k from efc_members where lower(full_name) = lower(nm) and left(date_of_birth, 10) = dob::text limit 1;
    end if;
    if k is not null then
      update efc_members set
        full_name = coalesce(nm, full_name),
        first_name = coalesce(nullif(btrim(r->>'first_name'), ''), first_name),
        last_name = coalesce(nullif(btrim(r->>'last_name'), ''), last_name),
        efc_reference = coalesce(ref, efc_reference),
        date_of_birth = coalesce(dob::text, date_of_birth),
        belt = coalesce(nullif(btrim(r->>'belt'), ''), belt),
        location = coalesce(nullif(btrim(r->>'location'), ''), location),
        programme = coalesce(nullif(btrim(r->>'programme'), ''), programme),
        status = coalesce(nullif(btrim(r->>'status'), ''), status),
        phone = coalesce(nullif(btrim(r->>'phone'), ''), phone),
        email = coalesce(nullif(btrim(r->>'email'), ''), email),
        guardian_name = coalesce(nullif(btrim(r->>'guardian_name'), ''), guardian_name),
        promoted_on = coalesce(v_promoted, promoted_on),
        attended_since_promoted = coalesce(v_classes, attended_since_promoted),
        attendance_total = coalesce(v_total, attendance_total),
        last_attended = coalesce(v_last, last_attended),
        updated_at = now()
      where member_key = k;
      n_up := n_up + 1;
    elsif nm is not null and (mid is not null or ref is not null) then
      insert into efc_members (member_key, kind, full_name, first_name, last_name, efc_reference, date_of_birth, belt, location, programme, status,
        phone, email, guardian_name, promoted_on, attended_since_promoted, attendance_total, last_attended, source, created_at, updated_at)
      values (case when mid is not null then 'efc:' || mid else 'ref:' || ref end, 'member', nm,
        nullif(btrim(r->>'first_name'), ''), nullif(btrim(r->>'last_name'), ''), ref, dob::text, nullif(btrim(r->>'belt'), ''), nullif(btrim(r->>'location'), ''),
        coalesce(nullif(btrim(r->>'programme'), ''), 'Taekwondo'), coalesce(nullif(btrim(r->>'status'), ''), 'Enrolled'),
        nullif(btrim(r->>'phone'), ''), nullif(btrim(r->>'email'), ''), nullif(btrim(r->>'guardian_name'), ''),
        v_promoted, v_classes, v_total, v_last, t, now(), now());
      n_add := n_add + 1;
    else
      n_skip := n_skip + 1;
    end if;
  end loop;
  return jsonb_build_object('updated', n_up, 'added', n_add, 'skipped', n_skip);
end $$;
revoke all on function public.cb_import_efc(jsonb) from public, anon;
grant execute on function public.cb_import_efc(jsonb) to authenticated;

-- 3. Students from other schools: a grading day can take students from more than its own school
--    (e.g. Marrickville members grading at Concord). Empty means only the day's own school.
alter table public.cb_days add column if not exists schools text[];
