-- AMA Toolkit: coloured belt grading, update 15 (leave out cancelled students and students on hold)
-- Run once in Supabase > SQL Editor, after coloured-belts-14.sql. Safe to run again.
--
-- EFC's Assessment Query still returns members who have cancelled or are on a hold, so they showed up on Who's ready
-- and could be invited (e.g. George Tamvakellis, cancelled, still listed at Sylvania). The AMA admin hub already keeps
-- the cancellation and hold records, so it sends this app a "skip list" once a day:
--   POST https://<project>.supabase.co/rest/v1/rpc/cb_skip_sync   (apikey: the publishable key)
--   { "p_key": "<skip key from cb_settings>", "p_rows": [{ "efc_id": "...", "name": "...", "reason": "Cancelled", "until": "2026-12-01" }] }
-- Everyone on the list is left out of Who's ready (cb_students) until their "until" date (no date = until removed),
-- and the "cb" function refuses to text them even if they were already added to a grading day.
-- Staff can also skip someone by hand (source 'manual'); the hub's daily sync only replaces its own rows.

create table if not exists public.cb_skip (
  member_key text primary key,              -- 'efc:<EFC member id>'
  full_name  text,
  reason     text,                          -- Cancelled, On hold, Cancellation requested, ...
  until      date,                          -- null = until removed
  source     text not null default 'hub',   -- hub (daily sync) or manual
  updated_at timestamptz not null default now()
);
alter table public.cb_skip enable row level security;
drop policy if exists "read" on public.cb_skip;
create policy "read" on public.cb_skip for select to authenticated using (public.prep_has_role('instructor', 'grading', 'payments'));
revoke all on public.cb_skip from anon;
grant select on public.cb_skip to authenticated;

-- The key the hub sends with its daily list (shown nowhere in the app; copy it from Table Editor > cb_settings)
alter table public.cb_settings add column if not exists skip_key text not null default replace(gen_random_uuid()::text, '-', '');

create or replace function public.cb_skip_sync(p_key text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  if p_key is null or not exists (select 1 from cb_settings where skip_key = p_key) then raise exception 'Wrong key.'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'p_rows must be a list.'; end if;
  delete from cb_skip where source = 'hub';
  for r in select * from jsonb_array_elements(p_rows) loop
    continue when nullif(btrim(r->>'efc_id'), '') is null;
    insert into cb_skip (member_key, full_name, reason, until, source, updated_at)
    values ('efc:' || btrim(r->>'efc_id'), nullif(btrim(r->>'name'), ''), left(nullif(btrim(r->>'reason'), ''), 120),
            case when (r->>'until') ~ '^\d{4}-\d{2}-\d{2}' then left(r->>'until', 10)::date end, 'hub', now())
    on conflict (member_key) do update set full_name = excluded.full_name, reason = excluded.reason, until = excluded.until, updated_at = now()
      where cb_skip.source = 'hub';
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'skipped', n);
end $$;
revoke all on function public.cb_skip_sync(text, jsonb) from public;
grant execute on function public.cb_skip_sync(text, jsonb) to anon, authenticated;

-- Is this student skipped today? (used by the view and the "cb" function)
create or replace function public.cb_is_skipped(p_member text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from cb_skip where member_key = p_member and (until is null or until >= current_date));
$$;
revoke all on function public.cb_is_skipped(text) from public, anon;
grant execute on function public.cb_is_skipped(text) to authenticated, service_role;

-- Who's ready: the same as update 12, without skipped students
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
  m.bbc_invited_at, m.bbc_invited_by, m.bbc_written_at, m.bbc_written_by
from public.efc_grades g
join public.efc_members m on m.member_key = g.member_key
join public.cb_belts b on b.programme = g.programme and b.belt = g.belt
left join public.cb_approvals a on a.member_key = g.member_key and a.programme = g.programme
where m.kind = 'member'
  and m.location = any (array['Marrickville', 'Sydenham', 'Concord', 'West', 'Sylvania'])
  and not exists (select 1 from public.cb_skip k where k.member_key = m.member_key and (k.until is null or k.until >= current_date));
revoke all on public.cb_students from anon;
grant select on public.cb_students to authenticated;
