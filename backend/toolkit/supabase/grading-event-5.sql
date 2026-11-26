-- grading-event-5: the event app and the Grading Floor's live run sheet stay on the same step.
-- The event's run sheet (cb_runsheets, built by gevent's seed) has one step per event step, each tagged ge: {block, step}.
-- Moving on either side moves the other: cb_runsheet_live.step_ix <-> ge_events.live {block, step}.
alter table public.ge_events add column if not exists floor_slot text;

-- The run sheet's steps in order, with their position in the event (block, step)
create or replace function public.ge_floor_steps(p_day uuid, p_slot text)
returns table (ix integer, block integer, step integer)
language sql stable security definer set search_path = public as $$
  select (row_number() over (order by s.si, t.ti) - 1)::int, (t.st->'ge'->>'block')::int, (t.st->'ge'->>'step')::int
  from public.cb_days d
  join public.cb_runsheets r on r.runsheet_id = (d.runsheets->>p_slot)::uuid
  cross join lateral jsonb_array_elements(r.doc->'sections') with ordinality s(sec, si)
  cross join lateral jsonb_array_elements(s.sec->'steps') with ordinality t(st, ti)
  where d.day_id = p_day
$$;

-- Floor moved -> event follows (and its step timer starts)
create or replace function public.ge_sync_from_floor() returns trigger
language plpgsql security definer set search_path = public as $$
declare e record; m record;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if tg_op = 'UPDATE' and new.step_ix is not distinct from old.step_ix then return new; end if;
  for e in select event_id, live from public.ge_events where day_id = new.day_id and floor_slot = new.slot loop
    select * into m from public.ge_floor_steps(new.day_id, new.slot) f where f.ix = new.step_ix;
    if m.block is null then continue; end if;
    if (e.live->>'block')::int is distinct from m.block or (e.live->>'step')::int is distinct from m.step then
      update public.ge_events set live = live || jsonb_build_object('block', m.block, 'step', m.step, 'started', to_jsonb(now())), updated_at = now()
       where event_id = e.event_id;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists ge_sync_from_floor on public.cb_runsheet_live;
create trigger ge_sync_from_floor after insert or update on public.cb_runsheet_live for each row execute function public.ge_sync_from_floor();

-- Event moved -> floor follows (keeps the floor's ticks)
create or replace function public.ge_sync_to_floor() returns trigger
language plpgsql security definer set search_path = public as $$
declare ix int;
begin
  if pg_trigger_depth() > 1 or new.floor_slot is null or new.day_id is null then return new; end if;
  if (new.live->'block') is not distinct from (old.live->'block') and (new.live->'step') is not distinct from (old.live->'step') then return new; end if;
  select f.ix into ix from public.ge_floor_steps(new.day_id, new.floor_slot) f
   where f.block = coalesce((new.live->>'block')::int, 0) and f.step = coalesce((new.live->>'step')::int, 0);
  if ix is null then return new; end if;
  insert into public.cb_runsheet_live (day_id, slot, step_ix, move_ix, ticks, updated_at) values (new.day_id, new.floor_slot, ix, 0, '{}'::jsonb, now())
  on conflict (day_id, slot) do update set step_ix = excluded.step_ix, move_ix = 0, updated_at = now()
  where public.cb_runsheet_live.step_ix is distinct from excluded.step_ix;
  return new;
end $$;
drop trigger if exists ge_sync_to_floor on public.ge_events;
create trigger ge_sync_to_floor after update of live on public.ge_events for each row execute function public.ge_sync_to_floor();
