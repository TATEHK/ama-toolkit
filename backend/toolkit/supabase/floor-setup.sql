-- floor-setup.sql
-- Grading-day floor plan + self check-in for the Coloured Belts app.
--
-- Two web pages use this schema (both under site/grading/):
--   floor/      the staff floor plan: groups/cones, drag students, status (future/current/past),
--               score cards, curriculum tick-off, student profiles, roster check-in. Signed-in staff
--               (app_permissions app='cb'), permission-checked server-side.
--   check-in/   the member self check-in kiosk. No login: each grading day has a short checkin_code,
--               the kiosk pairs to a day by code, and students tap their name to mark arrival and
--               see their group cone. Anon, gated only by the code.
--
-- Groups are generated from the full expected roster so every booked student has a cone BEFORE they
-- arrive; check-in only marks arrival, it never reshuffles the cones.
--
-- Idempotent: safe to re-run. Permission helper cb_has_cb is defined in the hub setup and repeated
-- here so this file stands alone.

-- ---------------------------------------------------------------- cb_days additions
alter table public.cb_days add column if not exists floor_spots int default 13;
alter table public.cb_days add column if not exists checkin_code text;
alter table public.cb_days drop constraint if exists cb_days_checkin_code_chk;
alter table public.cb_days add constraint cb_days_checkin_code_chk check (checkin_code is null or checkin_code ~ '^[A-Z0-9]{4,8}$');
create unique index if not exists cb_days_checkin_code_uq on public.cb_days (checkin_code) where checkin_code is not null;

-- ---------------------------------------------------------------- tables
create table if not exists public.cb_groups (
  group_id   uuid primary key default gen_random_uuid(),
  day_id     uuid not null references public.cb_days(day_id) on delete cascade,
  ord        int  not null,
  cone       text not null,
  belt       text,
  spots      int  not null default 13,
  rows       int  not null default 2,
  status     text not null default 'future' check (status in ('future','current','past')),
  slots      jsonb not null default '[]'::jsonb,   -- ordered array of entry_id text (or null for an empty spot)
  updated_at timestamptz not null default now()
);
create index if not exists cb_groups_day_idx on public.cb_groups (day_id, ord);

create table if not exists public.cb_scores (
  entry_id   uuid primary key references public.cb_entries(entry_id) on delete cascade,
  scores     jsonb not null default '{}'::jsonb,    -- {component: 0..10}
  pattern    jsonb,                                 -- {attempt:int, res:'pass'|'fail'|null} for Red Three -> Cho Dan Bo
  ticks      jsonb not null default '[]'::jsonb,    -- ["component#index", ...] curriculum items ticked off
  updated_at timestamptz not null default now(),
  updated_by text
);

-- RLS on: no table policies, so the only way in is the security-definer RPCs below.
alter table public.cb_groups enable row level security;
alter table public.cb_scores enable row level security;

-- ---------------------------------------------------------------- permission helper (also in hub setup)
create or replace function public.cb_has_cb(p_perms text[])
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.app_permissions
    where email = lower(auth.jwt() ->> 'email') and app = 'cb' and (perm = 'admin' or perm = any(p_perms)))
$$;

-- ---------------------------------------------------------------- staff reads (signed in, permission-checked)
create or replace function public.cb_floor_days()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['view','days','readiness','results','calls','texts','payments']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('day_id',d.day_id,'date',d.grading_date,'location',d.location,'entries',c.n,'code',d.checkin_code) order by d.grading_date, d.location),'[]'::jsonb)
    from public.cb_days d
    left join lateral (select count(*) n from public.cb_entries e where e.day_id = d.day_id) c on true
    where d.closed is not true and d.grading_date >= current_date - 1 and c.n > 0);
end $$;

create or replace function public.cb_floor_load(p_day uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare out jsonb;
begin
  if not public.cb_has_cb(array['view','days','readiness','results','calls','texts','payments']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'day', (select jsonb_build_object('day_id',d.day_id,'date',d.grading_date,'location',d.location,'start_time',d.start_time,
              'belt_times',d.belt_times,'floor_spots',d.floor_spots,'checkin_code',d.checkin_code,'belts',d.belts,'closed',d.closed) from public.cb_days d where d.day_id = p_day),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('ord',g.ord,'cone',g.cone,'belt',g.belt,'spots',g.spots,'rows',g.rows,'status',g.status,'slots',g.slots) order by g.ord),'[]'::jsonb) from public.cb_groups g where g.day_id = p_day),
    'students', (select coalesce(jsonb_agg(q.s order by q.full_name),'[]'::jsonb) from (
        select e.full_name, jsonb_build_object(
          'entry_id',e.entry_id,'member_key',e.member_key,'full_name',e.full_name,'belt_from',e.belt_from,'belt_to',e.belt_to,
          'checked_in', e.checked_in_at is not null,'checked_in_at',e.checked_in_at,'result',e.result,'booked', e.booked_at is not null,'paid',e.paid,
          'age', case when m.date_of_birth ~ '^\d{4}-\d{2}-\d{2}' then extract(year from age((substr(m.date_of_birth,1,10))::date))::int end,
          'loc', m.location,'programme', m.programme,
          'weeks', case when m.promoted_on is not null then ((current_date - m.promoted_on)/7)::int end,
          'classes', m.attended_since_promoted,
          'ready', coalesce(m.ready_to_promote,false),
          'bbc', (m.bbc_seen_at is not null and m.bbc_seen_at > now() - interval '3 days'),
          'sub', not coalesce(m.allowed_no_sub,false),
          'family', lower(coalesce(nullif(m.guardian_email,''), m.guardian_phone, '')),
          'attend', case when m.last_attended is null or m.last_attended < (now() - interval '28 days')::date then 'red'
                         when m.last_attended < (now() - interval '14 days')::date then 'orange' else 'green' end,
          'last_attended', m.last_attended,'attendance_total', m.attendance_total,
          'score', (select jsonb_build_object('scores',sc.scores,'pattern',sc.pattern,'ticks',sc.ticks) from public.cb_scores sc where sc.entry_id = e.entry_id)
        ) s
        from public.cb_entries e left join public.efc_members m on m.member_key = e.member_key
        where e.day_id = p_day
      ) q)
  ) into out;
  return out;
end $$;

-- ---------------------------------------------------------------- staff writes
create or replace function public.cb_floor_set_code(p_day uuid)
returns text language plpgsql security definer set search_path to 'public' as $$
declare c text;
begin
  if not public.cb_has_cb(array['days']) then raise exception 'not allowed' using errcode = '42501'; end if;
  select checkin_code into c from public.cb_days where day_id = p_day;
  if c is null then
    loop
      c := upper(substr(md5(random()::text), 1, 5));
      begin update public.cb_days set checkin_code = c where day_id = p_day; exit; exception when unique_violation then end;
    end loop;
  end if;
  return c;
end $$;

create or replace function public.cb_floor_save_groups(p_day uuid, p_groups jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['days','results','readiness']) then raise exception 'not allowed' using errcode='42501'; end if;
  delete from public.cb_groups where day_id = p_day;
  insert into public.cb_groups (day_id, ord, cone, belt, spots, rows, status, slots)
    select p_day, (x->>'ord')::int, x->>'cone', x->>'belt',
           coalesce((x->>'spots')::int,13), coalesce((x->>'rows')::int,2), coalesce(x->>'status','future'), coalesce(x->'slots','[]'::jsonb)
    from jsonb_array_elements(p_groups) x;
end $$;

create or replace function public.cb_group_patch(p_day uuid, p_ord integer, p_patch jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['days','results','readiness']) then raise exception 'not allowed' using errcode='42501'; end if;
  if (p_patch->>'status') = 'current' then
    update public.cb_groups set status='past', updated_at=now() where day_id=p_day and status='current' and ord <> p_ord;
  end if;
  update public.cb_groups set
    status = coalesce(p_patch->>'status', status),
    slots  = coalesce(p_patch->'slots', slots),
    spots  = coalesce((p_patch->>'spots')::int, spots),
    rows   = coalesce((p_patch->>'rows')::int, rows),
    updated_at = now()
  where day_id = p_day and ord = p_ord;
end $$;

create or replace function public.cb_score_save(p_entry uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
declare me text := lower(auth.jwt() ->> 'email');
begin
  if not public.cb_has_cb(array['days','results','readiness']) then raise exception 'not allowed' using errcode='42501'; end if;
  insert into public.cb_scores (entry_id, scores, pattern, ticks, updated_at, updated_by)
    values (p_entry, coalesce(p_patch->'scores','{}'::jsonb), p_patch->'pattern', coalesce(p_patch->'ticks','[]'::jsonb), now(), me)
  on conflict (entry_id) do update set
    scores  = coalesce(p_patch->'scores', cb_scores.scores),
    pattern = case when p_patch ? 'pattern' then p_patch->'pattern' else cb_scores.pattern end,
    ticks   = coalesce(p_patch->'ticks', cb_scores.ticks),
    updated_at = now(), updated_by = me;
end $$;

-- staff check-in toggle (mark a student arrived / not arrived from the floor roster)
create or replace function public.cb_floor_checkin(p_entry uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare e public.cb_entries%rowtype;
begin
  if not public.cb_has_cb(array['view','days','readiness','results']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.cb_entries
     set checked_in_at = case when p_on then coalesce(checked_in_at, now()) else null end
   where entry_id = p_entry
   returning * into e;
  if not found then return jsonb_build_object('error','not_found'); end if;
  return jsonb_build_object('ok', true, 'checked_in', e.checked_in_at is not null);
end $$;

-- super override: clear every score and check-in for a day so a grading can be re-run.
-- does not touch recorded results or EFC data.
create or replace function public.cb_floor_reset(p_day uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['results','days']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.cb_scores where entry_id in (select entry_id from public.cb_entries where day_id = p_day);
  update public.cb_entries set checked_in_at = null where day_id = p_day;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- member kiosk (anon, gated by the day's code)
create or replace function public.cb_checkin_feed(p_code text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare d public.cb_days%rowtype; out jsonb;
begin
  select * into d from public.cb_days where checkin_code = upper(trim(coalesce(p_code,'')));
  if not found then return jsonb_build_object('error','wrong_code'); end if;
  select jsonb_build_object(
    'day', jsonb_build_object('date', d.grading_date, 'location', d.location),
    'students', (select coalesce(jsonb_agg(jsonb_build_object(
        'entry_id', e.entry_id,
        'name', split_part(e.full_name,' ',1) || case when split_part(e.full_name,' ',2) <> '' then ' ' || left(split_part(e.full_name,' ',2),1) || '.' else '' end,
        'belt', e.belt_from, 'loc', m.location,
        'cone', (select g.cone from public.cb_groups g where g.day_id = d.day_id and g.slots @> to_jsonb(e.entry_id::text) limit 1),
        'checked_in', e.checked_in_at is not null
      ) order by e.full_name), '[]'::jsonb)
      from public.cb_entries e left join public.efc_members m on m.member_key = e.member_key where e.day_id = d.day_id)
  ) into out;
  return out;
end $$;

create or replace function public.cb_checkin_mark(p_code text, p_entry uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare d public.cb_days%rowtype; e public.cb_entries%rowtype; cone text;
begin
  select * into d from public.cb_days where checkin_code = upper(trim(coalesce(p_code,'')));
  if not found then return jsonb_build_object('error','wrong_code'); end if;
  select * into e from public.cb_entries where entry_id = p_entry and day_id = d.day_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if e.checked_in_at is null then update public.cb_entries set checked_in_at = now() where entry_id = e.entry_id; end if;
  select g.cone into cone from public.cb_groups g where g.day_id = d.day_id and g.slots @> to_jsonb(e.entry_id::text) limit 1;
  return jsonb_build_object('ok', true, 'name', split_part(e.full_name,' ',1), 'belt_from', e.belt_from, 'belt_to', e.belt_to, 'cone', cone);
end $$;

-- ---------------------------------------------------------------- grants
grant execute on function public.cb_floor_days() to authenticated;
grant execute on function public.cb_floor_load(uuid) to authenticated;
grant execute on function public.cb_floor_set_code(uuid) to authenticated;
grant execute on function public.cb_floor_save_groups(uuid, jsonb) to authenticated;
grant execute on function public.cb_group_patch(uuid, integer, jsonb) to authenticated;
grant execute on function public.cb_score_save(uuid, jsonb) to authenticated;
grant execute on function public.cb_floor_checkin(uuid, boolean) to authenticated;
grant execute on function public.cb_floor_reset(uuid) to authenticated;
-- kiosk is anon:
grant execute on function public.cb_checkin_feed(text) to anon, authenticated;
grant execute on function public.cb_checkin_mark(text, uuid) to anon, authenticated;
