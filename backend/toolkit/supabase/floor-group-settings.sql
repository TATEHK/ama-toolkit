-- floor-group-settings.sql (21 Nov 2026): settings per floor plan group.
-- cb_groups.opts = {title, belts, order}: the group's own name (blank = from its belts), the belts in it (small belts share
-- a group, each standing together), and the order students stand in (young, old, az, manual).
alter table public.cb_groups add column if not exists opts jsonb not null default '{}'::jsonb;

create or replace function public.cb_floor_save_groups(p_day uuid, p_groups jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['days','results','readiness']) then raise exception 'not allowed' using errcode='42501'; end if;
  delete from public.cb_groups where day_id = p_day;
  insert into public.cb_groups (day_id, ord, cone, belt, spots, rows, status, slots, opts)
    select p_day, (x->>'ord')::int, x->>'cone', x->>'belt',
           coalesce((x->>'spots')::int,13), coalesce((x->>'rows')::int,2), coalesce(x->>'status','future'), coalesce(x->'slots','[]'::jsonb),
           case when jsonb_typeof(x->'opts') = 'object' then x->'opts' else '{}'::jsonb end
    from jsonb_array_elements(p_groups) x;
end $$;

-- cb_floor_load: return each group's opts too (rewrites the live definition in place)
do $$ declare d text; begin
  d := pg_get_functiondef('public.cb_floor_load(uuid)'::regprocedure);
  if position('''opts'',g.opts' in d) = 0 then
    d := replace(d, '''slots'',g.slots)', '''slots'',g.slots,''opts'',g.opts)');
    execute d;
  end if;
end $$;
