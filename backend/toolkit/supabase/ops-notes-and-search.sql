-- Pinned notes per grading + the "find a student" search for the Operations dashboard.
-- All need the Operations permission ('ops'). Note removal is done in the cb function (ops_note_remove).

create table if not exists public.cb_day_notes (
  note_id uuid primary key default gen_random_uuid(),
  day_id uuid references public.cb_days(day_id) on delete cascade,
  note text not null,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.cb_day_notes enable row level security;
create index if not exists cb_day_notes_day on public.cb_day_notes(day_id);

create or replace function public.cb_ops_day_notes()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['ops']) then raise exception 'not allowed' using errcode='42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'note_id', n.note_id, 'day_id', n.day_id, 'grading_date', d.grading_date, 'location', d.location, 'programme', d.programme,
      'note', n.note, 'by', n.created_by, 'created_at', n.created_at) order by d.grading_date, n.created_at), '[]'::jsonb)
    from public.cb_day_notes n join public.cb_days d on d.day_id = n.day_id
    where d.grading_date >= current_date - 3);
end $$;
grant execute on function public.cb_ops_day_notes() to authenticated;

create or replace function public.cb_ops_note_add(p_day_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.cb_day_notes%rowtype;
begin
  if not public.cb_has_cb(array['ops']) then raise exception 'not allowed' using errcode='42501'; end if;
  if coalesce(btrim(p_note),'')='' then raise exception 'note required'; end if;
  insert into public.cb_day_notes(day_id, note, created_by)
    values (p_day_id, left(btrim(p_note),500), nullif(auth.jwt()->>'email',''))
    returning * into r;
  return to_jsonb(r);
end $$;
grant execute on function public.cb_ops_note_add(uuid, text) to authenticated;

-- find a student: name search across entries, with grading/booking/payment status and the last message
create or replace function public.cb_ops_find_student(p_q text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['ops']) then raise exception 'not allowed' using errcode='42501'; end if;
  if length(btrim(coalesce(p_q,''))) < 2 then return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'name', e.full_name, 'belt_from', e.belt_from, 'belt_to', e.belt_to, 'school', d.location, 'programme', d.programme,
      'grading_date', d.grading_date, 'days_until', (d.grading_date - current_date),
      'invited', e.invited_at is not null, 'booked', e.booked_at is not null, 'paid', e.paid,
      'result', e.result, 'cant_make', e.cant_make_at is not null,
      'last_msg', (select msg.kind || ' · ' || msg.status from public.cb_messages msg where msg.entry_id = e.entry_id order by msg.sent_at desc limit 1),
      'last_msg_at', (select msg.sent_at from public.cb_messages msg where msg.entry_id = e.entry_id order by msg.sent_at desc limit 1))
      order by d.grading_date desc), '[]'::jsonb)
    from public.cb_entries e join public.cb_days d on d.day_id = e.day_id
    where e.full_name ilike '%' || btrim(p_q) || '%'
    limit 50);
end $$;
grant execute on function public.cb_ops_find_student(text) to authenticated;
