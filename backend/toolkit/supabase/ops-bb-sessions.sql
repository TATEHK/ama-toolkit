-- Black belt grading helpers, grouped by session, for the Operations dashboard (/admin).
-- Reads the Black Belt app's prep tables (prep_helper_slots = the sessions, prep_helpers = who's on each,
-- joined to prep_overview / prep_students for names and ranks). Mirrors the "Black belt" tab on the
-- Grading Helpers page. 4th Dan and above count towards each session's cap ("senior"); anyone else is an extra.
-- Needs the Operations permission ('ops'); admins always pass.

create or replace function public.cb_ops_bb_sessions()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['ops']) then raise exception 'not allowed' using errcode='42501'; end if;
  return (select coalesce(jsonb_agg(obj order by gd, srt, lbl), '[]'::jsonb) from (
    select sl.grading_date gd, sl.sort srt, sl.label lbl, jsonb_build_object(
      'slot_id', sl.slot_id, 'grading_date', sl.grading_date, 'label', sl.label, 'start_time', sl.start_time, 'cap', sl.cap,
      'senior', (select count(*) from public.prep_helpers h where h.cycle_id = sl.cycle_id and sl.slot_id = any(h.slot_ids) and h.senior),
      'total', (select count(*) from public.prep_helpers h where h.cycle_id = sl.cycle_id and sl.slot_id = any(h.slot_ids)),
      'helpers', (select coalesce(jsonb_agg(jsonb_build_object(
            'name', coalesce(ov.full_name, st.full_name),
            'rank', coalesce(ov.grading_to, ov.belt_rank, st.belt_rank),
            'senior', h.senior) order by h.senior desc nulls last, coalesce(ov.full_name, st.full_name)), '[]'::jsonb)
          from public.prep_helpers h
          left join public.prep_overview ov on ov.cycle_id = h.cycle_id and ov.student_id = h.student_id
          left join public.prep_students st on st.student_id = h.student_id
          where h.cycle_id = sl.cycle_id and sl.slot_id = any(h.slot_ids))
      ) obj
    from public.prep_helper_slots sl where sl.grading_date >= current_date
  ) t);
end $$;

grant execute on function public.cb_ops_bb_sessions() to authenticated;
