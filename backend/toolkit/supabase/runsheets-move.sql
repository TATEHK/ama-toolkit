-- runsheets-move: add a "current move" position to the live run sheet, for Present mode
-- (big one-move-at-a-time screen). cb_runsheet_live_save / cb_runsheet_for_slot now carry move_ix.

alter table public.cb_runsheet_live add column if not exists move_ix int not null default 0;

drop function if exists public.cb_runsheet_live_save(uuid, text, int, jsonb);
create or replace function public.cb_runsheet_live_save(p_day uuid, p_slot text, p_step_ix int, p_move_ix int, p_ticks jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.cb_runsheet_live(day_id, slot, step_ix, move_ix, ticks, updated_at)
    values (p_day, p_slot, coalesce(p_step_ix,0), coalesce(p_move_ix,0), coalesce(p_ticks,'{}'::jsonb), now())
  on conflict (day_id, slot) do update set step_ix=excluded.step_ix, move_ix=excluded.move_ix, ticks=excluded.ticks, updated_at=now();
end $$;
grant execute on function public.cb_runsheet_live_save(uuid, text, int, int, jsonb) to authenticated;

create or replace function public.cb_runsheet_for_slot(p_day uuid, p_slot text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare rid uuid; res jsonb;
begin
  select (d.runsheets->>p_slot)::uuid into rid from public.cb_days d where d.day_id = p_day;
  if rid is null then return null; end if;
  select jsonb_build_object(
    'runsheet_id', r.runsheet_id, 'title', r.title, 'doc', r.doc,
    'live', coalesce((select jsonb_build_object('step_ix', l.step_ix, 'move_ix', l.move_ix, 'ticks', l.ticks)
                        from public.cb_runsheet_live l where l.day_id=p_day and l.slot=p_slot),
                     jsonb_build_object('step_ix', 0, 'move_ix', 0, 'ticks', '{}'::jsonb)))
  into res from public.cb_runsheets r where r.runsheet_id = rid;
  return res;
end $$;
grant execute on function public.cb_runsheet_for_slot(uuid, text) to authenticated;
