-- runsheets: reusable black belt grading run sheets + live, tickable script on the floor.
--
-- A run sheet is a reusable template (doc jsonb): title, note, window, groups, and sections -> ordered
-- timed steps (time, groups, belt, mins, technique items, and an optional per-level table). A day's
-- grading slot (keyed by its start time, e.g. "08:00") is assigned a run sheet via cb_days.runsheets.
-- The floor runs it live: cb_runsheet_live holds the current step and which items are ticked, per day+slot.

create table if not exists public.cb_runsheets (
  runsheet_id uuid primary key default gen_random_uuid(),
  title       text not null default 'Untitled run sheet',
  programme   text not null default 'Taekwondo',
  doc         jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
alter table public.cb_runsheets enable row level security;   -- reached only through the SECURITY DEFINER RPCs below

-- which run sheet each grading slot on a day uses: { "<slot start time>": "<runsheet_id>" }
alter table public.cb_days add column if not exists runsheets jsonb not null default '{}'::jsonb;

-- live state for one day's one grading slot: where the host is up to, and what's ticked off
create table if not exists public.cb_runsheet_live (
  day_id     uuid not null,
  slot       text not null,
  step_ix    int  not null default 0,
  ticks      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (day_id, slot)
);
alter table public.cb_runsheet_live enable row level security;

-- ---- RPCs (trust the hub login like the other cb_floor_* RPCs; the app gates editing by role) ----

create or replace function public.cb_runsheets_list()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'runsheet_id', runsheet_id, 'title', title, 'programme', programme, 'updated_at', updated_at) order by title), '[]'::jsonb)
  from public.cb_runsheets;
$$;

create or replace function public.cb_runsheet_get(p_id uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('runsheet_id', runsheet_id, 'title', title, 'programme', programme, 'doc', doc, 'updated_at', updated_at)
  from public.cb_runsheets where runsheet_id = p_id;
$$;

create or replace function public.cb_runsheet_save(p_id uuid, p_title text, p_programme text, p_doc jsonb)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v uuid;
begin
  if p_id is null then
    insert into public.cb_runsheets(title, programme, doc, updated_by)
      values (coalesce(nullif(btrim(p_title),''),'Untitled run sheet'), coalesce(nullif(btrim(p_programme),''),'Taekwondo'),
              coalesce(p_doc,'{}'::jsonb), lower(auth.jwt()->>'email'))
      returning runsheet_id into v;
  else
    update public.cb_runsheets
       set title=coalesce(nullif(btrim(p_title),''),title), programme=coalesce(nullif(btrim(p_programme),''),programme),
           doc=coalesce(p_doc,doc), updated_at=now(), updated_by=lower(auth.jwt()->>'email')
     where runsheet_id=p_id returning runsheet_id into v;
  end if;
  return v;
end $$;

create or replace function public.cb_runsheet_delete(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  delete from public.cb_runsheets where runsheet_id = p_id;
  update public.cb_days set runsheets = (
    select coalesce(jsonb_object_agg(k, val), '{}'::jsonb) from jsonb_each_text(runsheets) as e(k, val) where val <> p_id::text
  ) where runsheets ? p_id::text;
end $$;

-- assign (or clear, with p_runsheet null) a run sheet to a day's grading slot
create or replace function public.cb_day_runsheet_set(p_day uuid, p_slot text, p_runsheet uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if p_runsheet is null then
    update public.cb_days set runsheets = coalesce(runsheets,'{}'::jsonb) - p_slot where day_id = p_day;
  else
    update public.cb_days set runsheets = coalesce(runsheets,'{}'::jsonb) || jsonb_build_object(p_slot, p_runsheet::text) where day_id = p_day;
  end if;
end $$;

-- the run sheet (with live state) assigned to a day's grading slot, for the floor
create or replace function public.cb_runsheet_for_slot(p_day uuid, p_slot text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare rid uuid; res jsonb;
begin
  select (d.runsheets->>p_slot)::uuid into rid from public.cb_days d where d.day_id = p_day;
  if rid is null then return null; end if;
  select jsonb_build_object(
    'runsheet_id', r.runsheet_id, 'title', r.title, 'doc', r.doc,
    'live', coalesce((select jsonb_build_object('step_ix', l.step_ix, 'ticks', l.ticks)
                        from public.cb_runsheet_live l where l.day_id=p_day and l.slot=p_slot),
                     jsonb_build_object('step_ix', 0, 'ticks', '{}'::jsonb)))
  into res from public.cb_runsheets r where r.runsheet_id = rid;
  return res;
end $$;

create or replace function public.cb_runsheet_live_save(p_day uuid, p_slot text, p_step_ix int, p_ticks jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.cb_runsheet_live(day_id, slot, step_ix, ticks, updated_at)
    values (p_day, p_slot, coalesce(p_step_ix,0), coalesce(p_ticks,'{}'::jsonb), now())
  on conflict (day_id, slot) do update set step_ix=excluded.step_ix, ticks=excluded.ticks, updated_at=now();
end $$;

grant execute on function public.cb_runsheets_list() to authenticated;
grant execute on function public.cb_runsheet_get(uuid) to authenticated;
grant execute on function public.cb_runsheet_save(uuid, text, text, jsonb) to authenticated;
grant execute on function public.cb_runsheet_delete(uuid) to authenticated;
grant execute on function public.cb_day_runsheet_set(uuid, text, uuid) to authenticated;
grant execute on function public.cb_runsheet_for_slot(uuid, text) to authenticated;
grant execute on function public.cb_runsheet_live_save(uuid, text, int, jsonb) to authenticated;
