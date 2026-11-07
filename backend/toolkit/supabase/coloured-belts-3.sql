-- Gradings, update 3: every program, not just Taekwondo.
-- Run once in the Supabase SQL Editor (after coloured-belts.sql and coloured-belts-2.sql). Safe to run again.
--
-- Kung Fu, Kickboxing, BJJ, BJJ Kids, Tricking and Little Dragons grade the same way as Taekwondo coloured belts:
-- who's ready (classes since grading + instructor), grading days, booking links, results, certificates and texts.
-- Each program has its own grades (from EFC, in EFC's order), classes needed and fees.
-- Little Dragons also "move up" to Taekwondo: any Little Dragon belt grades to Taekwondo Yellow Belt, and
-- Master Belt grades to Taekwondo Orange Belt.

-- 1. Programs (named as in EFC)
create table if not exists public.cb_programmes (
  programme  text primary key,          -- EFC's program name, e.g. "Kick Boxing"
  label      text not null,             -- shown in the app, e.g. "Kickboxing"
  efc_id     text,                      -- EFC's program ID (for Zapier)
  sort       int not null default 0,
  active     boolean not null default true
);
insert into public.cb_programmes (programme, label, efc_id, sort) values
  ('Taekwondo', 'Taekwondo', '4931c915-82d0-4698-aa0a-630ced7bd578', 1),
  ('Taekwondo - Little Dragon', 'Little Dragons', 'cbf1ff0c-f335-494c-9956-d669d80cf621', 2),
  ('Kung Fu', 'Kung Fu', 'ad14de46-93c9-4b78-a48f-44ba0f585bed', 3),
  ('Kick Boxing', 'Kickboxing', '99744fac-c816-4052-9e97-993e8de74a6c', 4),
  ('BJJ', 'BJJ', 'e156acfc-e93a-4918-8a02-531f3fc3e1a1', 5),
  ('BJJ Kids', 'BJJ Kids', '5b5af9b7-8966-4d42-9a4e-15b13031d4be', 6),
  ('Tricking', 'Tricking', 'd0ea03ed-e172-4ea1-bbbe-b0b2308a371b', 7)
on conflict (programme) do nothing;

-- 2. Grades per program. A grade can lead into another program (next_programme), and Little Dragons can also
--    move up to Taekwondo (up_belt, up_programme).
alter table public.cb_belts add column if not exists programme text not null default 'Taekwondo';
alter table public.cb_belts add column if not exists next_programme text;
alter table public.cb_belts add column if not exists up_belt text;
alter table public.cb_belts add column if not exists up_programme text;
alter table public.cb_belts drop constraint if exists cb_belts_sort_key;
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'cb_belts_pkey'
             and pg_get_constraintdef(oid) = 'PRIMARY KEY (belt)') then
    alter table public.cb_belts drop constraint cb_belts_pkey;
    alter table public.cb_belts add constraint cb_belts_pkey primary key (programme, belt);
  end if;
end $$;
create unique index if not exists cb_belts_programme_sort on public.cb_belts (programme, sort);

insert into public.cb_belts (programme, belt, sort, next_belt, next_programme, up_belt, up_programme, colour) values
  -- Little Dragons (and moving up to Taekwondo)
  ('Taekwondo - Little Dragon', 'White Belt', 1, 'Yellow Belt', null, 'Yellow Belt', 'Taekwondo', '#e8e8e8'),
  ('Taekwondo - Little Dragon', 'Yellow Belt', 2, 'Orange Belt', null, 'Yellow Belt', 'Taekwondo', '#e5c700'),
  ('Taekwondo - Little Dragon', 'Orange Belt', 3, 'Green Belt', null, 'Yellow Belt', 'Taekwondo', '#e8822a'),
  ('Taekwondo - Little Dragon', 'Green Belt', 4, 'Blue Belt', null, 'Yellow Belt', 'Taekwondo', '#2e8b57'),
  ('Taekwondo - Little Dragon', 'Blue Belt', 5, 'Purple Belt', null, 'Yellow Belt', 'Taekwondo', '#2f5fa8'),
  ('Taekwondo - Little Dragon', 'Purple Belt', 6, 'Brown Belt', null, 'Yellow Belt', 'Taekwondo', '#7b4fa8'),
  ('Taekwondo - Little Dragon', 'Brown Belt', 7, 'Red Belt', null, 'Yellow Belt', 'Taekwondo', '#7a5230'),
  ('Taekwondo - Little Dragon', 'Red Belt', 8, 'Red/Black Belt', null, 'Yellow Belt', 'Taekwondo', '#c0392b'),
  ('Taekwondo - Little Dragon', 'Red/Black Belt', 9, 'Master Belt', null, 'Yellow Belt', 'Taekwondo', '#7a1f1f'),
  ('Taekwondo - Little Dragon', 'Master Belt', 10, 'Orange Belt', 'Taekwondo', 'Orange Belt', 'Taekwondo', '#d4af37'),
  -- Kung Fu (to Black Sash)
  ('Kung Fu', 'White Sash', 1, 'Yellow Sash', null, null, null, '#e8e8e8'),
  ('Kung Fu', 'Yellow Sash', 2, 'Yellow Stripe', null, null, null, '#e5c700'),
  ('Kung Fu', 'Yellow Stripe', 3, 'Orange Sash', null, null, null, '#e5c700'),
  ('Kung Fu', 'Orange Sash', 4, 'Orange Stripe', null, null, null, '#e8822a'),
  ('Kung Fu', 'Orange Stripe', 5, 'Green Sash', null, null, null, '#e8822a'),
  ('Kung Fu', 'Green Sash', 6, 'Green Stripe', null, null, null, '#2e8b57'),
  ('Kung Fu', 'Green Stripe', 7, 'Blue Sash', null, null, null, '#2e8b57'),
  ('Kung Fu', 'Blue Sash', 8, 'Blue Stripe', null, null, null, '#2f5fa8'),
  ('Kung Fu', 'Blue Stripe', 9, 'Brown Sash', null, null, null, '#2f5fa8'),
  ('Kung Fu', 'Brown Sash', 10, 'Brown Stripe', null, null, null, '#7a5230'),
  ('Kung Fu', 'Brown Stripe', 11, 'Brown/Black Sash', null, null, null, '#7a5230'),
  ('Kung Fu', 'Brown/Black Sash', 12, 'Brown/Black Stripe 1', null, null, null, '#4a3020'),
  ('Kung Fu', 'Brown/Black Stripe 1', 13, 'Brown/Black Stripe 2', null, null, null, '#4a3020'),
  ('Kung Fu', 'Brown/Black Stripe 2', 14, 'Brown/Black Stripe 3', null, null, null, '#4a3020'),
  ('Kung Fu', 'Brown/Black Stripe 3', 15, 'Black Sash First Degree', null, null, null, '#4a3020'),
  -- Kickboxing
  ('Kick Boxing', 'White Belt', 1, 'Yellow Belt', null, null, null, '#e8e8e8'),
  ('Kick Boxing', 'Yellow Belt', 2, 'Orange Belt', null, null, null, '#e5c700'),
  ('Kick Boxing', 'Orange Belt', 3, 'Green Belt', null, null, null, '#e8822a'),
  ('Kick Boxing', 'Green Belt', 4, 'Blue Belt', null, null, null, '#2e8b57'),
  ('Kick Boxing', 'Blue Belt', 5, 'Purple Belt', null, null, null, '#2f5fa8'),
  ('Kick Boxing', 'Purple Belt', 6, 'Brown Belt', null, null, null, '#7b4fa8'),
  ('Kick Boxing', 'Brown Belt', 7, 'Red Belt', null, null, null, '#7a5230'),
  ('Kick Boxing', 'Red Belt', 8, 'Cho Dan Bo Belt', null, null, null, '#c0392b'),
  ('Kick Boxing', 'Cho Dan Bo Belt', 9, 'Black Belt', null, null, null, '#5a2a2a'),
  -- BJJ
  ('BJJ', 'White Belt', 1, 'White Belt (Stripe 1)', null, null, null, '#e8e8e8'),
  ('BJJ', 'White Belt (Stripe 1)', 2, 'White Belt (Stripe 2)', null, null, null, '#e8e8e8'),
  ('BJJ', 'White Belt (Stripe 2)', 3, 'White Belt (Stripe 3)', null, null, null, '#e8e8e8'),
  ('BJJ', 'White Belt (Stripe 3)', 4, 'White Belt (Stripe 4)', null, null, null, '#e8e8e8'),
  ('BJJ', 'White Belt (Stripe 4)', 5, 'Blue Belt', null, null, null, '#e8e8e8'),
  ('BJJ', 'Blue Belt', 6, 'Blue Belt (Stripe 1)', null, null, null, '#2f5fa8'),
  ('BJJ', 'Blue Belt (Stripe 1)', 7, 'Blue Belt (Stripe 2)', null, null, null, '#2f5fa8'),
  ('BJJ', 'Blue Belt (Stripe 2)', 8, 'Blue Belt (Stripe 3)', null, null, null, '#2f5fa8'),
  ('BJJ', 'Blue Belt (Stripe 3)', 9, 'Blue Belt (Stripe 4)', null, null, null, '#2f5fa8'),
  ('BJJ', 'Blue Belt (Stripe 4)', 10, 'Purple Belt', null, null, null, '#2f5fa8'),
  ('BJJ', 'Purple Belt', 11, 'Purple Belt (Stripe 1)', null, null, null, '#7b4fa8'),
  ('BJJ', 'Purple Belt (Stripe 1)', 12, 'Purple Belt (Stripe 2)', null, null, null, '#7b4fa8'),
  -- BJJ Kids
  ('BJJ Kids', 'White Belt', 1, 'White Belt (Stripe 1)', null, null, null, '#e8e8e8'),
  ('BJJ Kids', 'White Belt (Stripe 1)', 2, 'White Belt (Stripe 2)', null, null, null, '#e8e8e8'),
  ('BJJ Kids', 'White Belt (Stripe 2)', 3, 'White Belt (Stripe 3)', null, null, null, '#e8e8e8'),
  ('BJJ Kids', 'White Belt (Stripe 3)', 4, 'White Belt (Stripe 4)', null, null, null, '#e8e8e8'),
  ('BJJ Kids', 'White Belt (Stripe 4)', 5, 'Grey/White Belt', null, null, null, '#e8e8e8'),
  ('BJJ Kids', 'Grey/White Belt', 6, 'Grey/White Belt (Stripe 1)', null, null, null, '#bdbdbd'),
  ('BJJ Kids', 'Grey/White Belt (Stripe 1)', 7, 'Grey/White Belt (Stripe 2)', null, null, null, '#bdbdbd'),
  ('BJJ Kids', 'Grey/White Belt (Stripe 2)', 8, 'Grey/White Belt (Stripe 3)', null, null, null, '#bdbdbd'),
  ('BJJ Kids', 'Grey/White Belt (Stripe 3)', 9, 'Grey/White Belt (Stripe 4)', null, null, null, '#bdbdbd'),
  ('BJJ Kids', 'Grey/White Belt (Stripe 4)', 10, 'Grey Belt', null, null, null, '#bdbdbd'),
  ('BJJ Kids', 'Grey Belt', 11, 'Grey Belt (Stripe 1)', null, null, null, '#8e8e8e'),
  ('BJJ Kids', 'Grey Belt (Stripe 1)', 12, 'Grey Belt (Stripe 2)', null, null, null, '#8e8e8e'),
  ('BJJ Kids', 'Grey Belt (Stripe 2)', 13, 'Grey Belt (Stripe 3)', null, null, null, '#8e8e8e'),
  ('BJJ Kids', 'Grey Belt (Stripe 3)', 14, 'Grey Belt (Stripe 4)', null, null, null, '#8e8e8e'),
  -- Tricking
  ('Tricking', 'White Band', 1, 'Yellow Band', null, null, null, '#e8e8e8'),
  ('Tricking', 'Yellow Band', 2, 'Orange Band', null, null, null, '#e5c700'),
  ('Tricking', 'Orange Band', 3, 'Green Band', null, null, null, '#e8822a'),
  ('Tricking', 'Green Band', 4, 'Blue Band', null, null, null, '#2e8b57'),
  ('Tricking', 'Blue Band', 5, 'Purple Band', null, null, null, '#2f5fa8'),
  ('Tricking', 'Purple Band', 6, 'Brown Band', null, null, null, '#7b4fa8'),
  ('Tricking', 'Brown Band', 7, 'Red Band', null, null, null, '#7a5230'),
  ('Tricking', 'Red Band', 8, 'Red 2 Band', null, null, null, '#c0392b'),
  ('Tricking', 'Red 2 Band', 9, 'Red 3 Band', null, null, null, '#c0392b'),
  ('Tricking', 'Red 3 Band', 10, 'Cho Dan Bo Band', null, null, null, '#c0392b'),
  ('Tricking', 'Cho Dan Bo Band', 11, 'Black Band', null, null, null, '#5a2a2a')
on conflict (programme, belt) do nothing;

-- 3. Each student's grade in each program, from EFC (a student can be in more than one program)
create table if not exists public.efc_grades (
  member_key              text not null,           -- efc_members.member_key
  programme               text not null,
  belt                    text not null,
  belt_rank               int,
  promoted_on             date,
  attended_since_promoted int,
  updated_at              timestamptz not null default now(),
  primary key (member_key, programme)
);
alter table public.efc_grades enable row level security;
drop policy if exists "read" on public.efc_grades;
create policy "read" on public.efc_grades for select to authenticated using (public.prep_has_role('instructor', 'grading'));
revoke all on public.efc_grades from anon;
grant select on public.efc_grades to authenticated;

-- Taekwondo grades already live on efc_members: copy them, and keep the copy up to date
insert into public.efc_grades (member_key, programme, belt, promoted_on, attended_since_promoted, updated_at)
  select member_key, 'Taekwondo', belt, promoted_on, attended_since_promoted, updated_at from public.efc_members
   where programme = 'Taekwondo' and belt is not null
on conflict (member_key, programme) do update set belt = excluded.belt, promoted_on = excluded.promoted_on,
  attended_since_promoted = excluded.attended_since_promoted, updated_at = excluded.updated_at;
create or replace function public.efc_grades_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.programme = 'Taekwondo' and new.belt is not null then
    insert into efc_grades (member_key, programme, belt, promoted_on, attended_since_promoted, updated_at)
      values (new.member_key, 'Taekwondo', new.belt, new.promoted_on, new.attended_since_promoted, now())
    on conflict (member_key, programme) do update set belt = excluded.belt, promoted_on = excluded.promoted_on,
      attended_since_promoted = excluded.attended_since_promoted, updated_at = now();
  end if;
  return new;
end $$;
drop trigger if exists efc_grades_sync on public.efc_members;
create trigger efc_grades_sync after insert or update of belt, promoted_on, attended_since_promoted, programme on public.efc_members
  for each row execute function public.efc_grades_sync();

-- 4. Ready / not yet, grading days and entries belong to a program
alter table public.cb_approvals add column if not exists programme text not null default 'Taekwondo';
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'cb_approvals_pkey' and pg_get_constraintdef(oid) = 'PRIMARY KEY (member_key)') then
    alter table public.cb_approvals drop constraint cb_approvals_pkey;
    alter table public.cb_approvals add constraint cb_approvals_pkey primary key (member_key, programme);
  end if;
end $$;
alter table public.cb_days add column if not exists programme text not null default 'Taekwondo';
alter table public.cb_days add column if not exists move_up boolean not null default false;   -- Little Dragons moving up to Taekwondo
alter table public.cb_entries add column if not exists to_programme text;                    -- set when the new belt is in another program

-- 5. Students, per program
drop view if exists public.cb_students;
create view public.cb_students with (security_invoker = true) as
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
  case when m.date_of_birth ~ '^\d{4}-\d{2}-\d{2}' then extract(year from age(current_date, left(m.date_of_birth, 10)::date))::int end as age
from public.efc_grades g
join public.efc_members m on m.member_key = g.member_key
join public.cb_belts b on b.programme = g.programme and b.belt = g.belt
left join public.cb_approvals a on a.member_key = g.member_key and a.programme = g.programme
where m.kind = 'member'
  and m.location = any (array['Marrickville', 'Sydenham', 'Concord', 'West', 'Sylvania']);
revoke all on public.cb_students from anon;
grant select on public.cb_students to authenticated;

alter table public.cb_programmes enable row level security;
drop policy if exists "read" on public.cb_programmes;
drop policy if exists "write" on public.cb_programmes;
create policy "read" on public.cb_programmes for select to authenticated using (public.prep_has_role('instructor', 'grading', 'payments'));
create policy "write" on public.cb_programmes for all to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
revoke all on public.cb_programmes from anon;
grant select, insert, update, delete on public.cb_programmes to authenticated;

-- 6. Importing an EFC list also takes the program (Taekwondo if the file has none)
create or replace function public.cb_import_efc(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; k text; mid text; ref text; nm text; dob date; n_up int := 0; n_add int := 0; n_skip int := 0;
  t text := 'efc import'; prog text; blt text;
  v_promoted date; v_last date; v_classes int; v_total int;
begin
  if not public.prep_has_role('grading') then raise exception 'Only grading staff can import EFC lists.'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Expected a list of rows.'; end if;
  if jsonb_array_length(p_rows) > 6000 then raise exception 'Too many rows at once (6000 at most).'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    mid := nullif(btrim(r->>'member_id'), '');
    ref := nullif(btrim(r->>'reference'), '');
    nm := nullif(btrim(coalesce(nullif(btrim(r->>'full_name'), ''), concat_ws(' ', nullif(btrim(r->>'first_name'), ''), nullif(btrim(r->>'last_name'), '')))), '');
    prog := coalesce(nullif(btrim(r->>'programme'), ''), 'Taekwondo');
    blt := nullif(btrim(r->>'belt'), '');
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
        location = coalesce(nullif(btrim(r->>'location'), ''), location),
        status = coalesce(nullif(btrim(r->>'status'), ''), status),
        phone = coalesce(nullif(btrim(r->>'phone'), ''), phone),
        email = coalesce(nullif(btrim(r->>'email'), ''), email),
        guardian_name = coalesce(nullif(btrim(r->>'guardian_name'), ''), guardian_name),
        attendance_total = coalesce(v_total, attendance_total),
        last_attended = coalesce(v_last, last_attended),
        -- The Taekwondo grade also lives here (Black Belt Gradings uses it)
        belt = case when prog = 'Taekwondo' then coalesce(blt, belt) else belt end,
        promoted_on = case when prog = 'Taekwondo' then coalesce(v_promoted, promoted_on) else promoted_on end,
        attended_since_promoted = case when prog = 'Taekwondo' then coalesce(v_classes, attended_since_promoted) else attended_since_promoted end,
        updated_at = now()
      where member_key = k;
      n_up := n_up + 1;
    elsif nm is not null and (mid is not null or ref is not null) then
      k := case when mid is not null then 'efc:' || mid else 'ref:' || ref end;
      insert into efc_members (member_key, kind, full_name, first_name, last_name, efc_reference, date_of_birth, belt, location, programme, status,
        phone, email, guardian_name, promoted_on, attended_since_promoted, attendance_total, last_attended, source, created_at, updated_at)
      values (k, 'member', nm, nullif(btrim(r->>'first_name'), ''), nullif(btrim(r->>'last_name'), ''), ref, dob::text,
        case when prog = 'Taekwondo' then blt end, nullif(btrim(r->>'location'), ''), prog, coalesce(nullif(btrim(r->>'status'), ''), 'Enrolled'),
        nullif(btrim(r->>'phone'), ''), nullif(btrim(r->>'email'), ''), nullif(btrim(r->>'guardian_name'), ''),
        case when prog = 'Taekwondo' then v_promoted end, case when prog = 'Taekwondo' then v_classes end, v_total, v_last, t, now(), now());
      n_add := n_add + 1;
    else
      n_skip := n_skip + 1; continue;
    end if;
    if blt is not null and prog <> 'Taekwondo' then
      insert into efc_grades (member_key, programme, belt, promoted_on, attended_since_promoted, updated_at)
        values (k, prog, blt, v_promoted, v_classes, now())
      on conflict (member_key, programme) do update set belt = excluded.belt,
        promoted_on = coalesce(excluded.promoted_on, efc_grades.promoted_on),
        attended_since_promoted = coalesce(excluded.attended_since_promoted, efc_grades.attended_since_promoted), updated_at = now();
    end if;
  end loop;
  return jsonb_build_object('updated', n_up, 'added', n_add, 'skipped', n_skip);
end $$;
revoke all on function public.cb_import_efc(jsonb) from public, anon;
grant execute on function public.cb_import_efc(jsonb) to authenticated;
