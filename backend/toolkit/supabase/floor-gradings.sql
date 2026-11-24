-- floor-gradings: let the black belt floor layout split the day into its grading time-slots.
--
-- A black belt grading day runs as several back-to-back gradings (e.g. 8:00–10:00am, 10:30–12:30pm…),
-- each covering a set of ranks, defined in prep_time_groups (edited in the Black Belt prep system).
-- The floor page reads these so it can show Grading 1 / 2 / 3 / 4 instead of one big chunk, mapping each
-- student to a grading by their current belt rank (cb_entries.belt_from, which matches prep_time_groups.ranks).

create or replace function public.cb_bb_time_groups()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    jsonb_agg(jsonb_build_object('label', time_label, 'sort', sort, 'ranks', to_jsonb(ranks)) order by sort),
    '[]'::jsonb)
  from public.prep_time_groups;
$$;

grant execute on function public.cb_bb_time_groups() to authenticated;
