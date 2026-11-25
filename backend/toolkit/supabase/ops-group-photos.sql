-- Group photos for gradings. Staff upload a group photo on the Operations dashboard and say who it's for:
-- one belt (kids' gradings), a belt range (adults, e.g. white->green), or the whole session (location gradings).
-- The family photo page then shows each child their own photo plus the group photo that covers their belt.
-- Images live in the grading-photos storage bucket under group/<day_id>/. RPCs need the Operations permission.

create or replace function public.cb_belt_rank(p text) returns int language sql immutable as $$
  select case
    when p is null then null
    when lower(p) like '%cho dan bo%' then 11
    when lower(p) like '%red three%' then 10
    when lower(p) like '%red two%' then 9
    when lower(p) like '%red%' then 8
    when lower(p) like '%brown%' then 7
    when lower(p) like '%purple%' then 6
    when lower(p) like '%blue%' then 5
    when lower(p) like '%green%' then 4
    when lower(p) like '%orange%' then 3
    when lower(p) like '%yellow%' then 2
    when lower(p) like '%white%' then 1
    when lower(p) like '%poom%' or lower(p) like '%black%' then 12
    else null end;
$$;

create table if not exists public.cb_group_photos (
  group_photo_id uuid primary key default gen_random_uuid(),
  day_id uuid references public.cb_days(day_id) on delete cascade,
  scope text not null check (scope in ('belt','range','session')),
  belt_from text, belt_to text,
  belt_from_rank int, belt_to_rank int,
  label text,
  photo_path text not null,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.cb_group_photos enable row level security;
create index if not exists cb_group_photos_day on public.cb_group_photos(day_id);

create or replace function public.cb_ops_group_photos(p_day_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.cb_has_cb(array['ops']) then raise exception 'not allowed' using errcode='42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'group_photo_id', group_photo_id, 'scope', scope, 'belt_from', belt_from, 'belt_to', belt_to,
      'label', label, 'created_at', created_at) order by belt_from_rank nulls first, created_at), '[]'::jsonb)
    from public.cb_group_photos where day_id = p_day_id);
end $$;
grant execute on function public.cb_ops_group_photos(uuid) to authenticated;

create or replace function public.cb_ops_group_photo_save(p_day_id uuid, p_scope text, p_belt_from text, p_belt_to text, p_label text, p_path text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.cb_group_photos%rowtype; bf text; bt text;
begin
  if not public.cb_has_cb(array['ops']) then raise exception 'not allowed' using errcode='42501'; end if;
  if p_scope not in ('belt','range','session') then raise exception 'bad scope'; end if;
  if coalesce(btrim(p_path),'')='' then raise exception 'path required'; end if;
  bf := case when p_scope='session' then null else p_belt_from end;
  bt := case when p_scope='session' then null when p_scope='belt' then p_belt_from else p_belt_to end;
  insert into public.cb_group_photos(day_id, scope, belt_from, belt_to, belt_from_rank, belt_to_rank, label, photo_path, created_by)
    values (p_day_id, p_scope, bf, bt, public.cb_belt_rank(bf), public.cb_belt_rank(bt),
            nullif(left(btrim(coalesce(p_label,'')),80),''), p_path, nullif(auth.jwt()->>'email',''))
    returning * into r;
  return to_jsonb(r);
end $$;
grant execute on function public.cb_ops_group_photo_save(uuid, text, text, text, text, text) to authenticated;
