-- AMA Toolkit: coloured belt grading, update 4 (grading photos)
-- Run once in Supabase > SQL Editor, after coloured-belts-3.sql. Safe to run again.
-- On the day, grading staff take each student's photo with the Grandmaster on a phone or iPad from the grading day.
-- Photos go to a private storage bucket. Each family is texted a personal link (photo/#t=<their entry's code>)
-- where they can see and save their child's photo. Nobody else can open it.

alter table public.cb_entries add column if not exists photo_path text;   -- grading-photos/<day_id>/<entry_id>.jpg
alter table public.cb_entries add column if not exists photo_at   timestamptz;
alter table public.cb_entries add column if not exists photo_by   text;

alter table public.cb_settings add column if not exists photo_text text not null default
  'Hi {parent}, here is {first}''s photo with the Grandmaster from their grading. Congratulations on their {next}! {photo} AMA {school}';

alter table public.cb_messages drop constraint if exists cb_messages_kind_check;
alter table public.cb_messages add constraint cb_messages_kind_check
  check (kind in ('invite', 'not_booked', 'reminder', 'unpaid', 'congrats', 'retest', 'not_ready', 'photo'));

-- ---------- Photos: a private storage bucket ----------
insert into storage.buckets (id, name, public) values ('grading-photos', 'grading-photos', false) on conflict (id) do update set public = false;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    execute $q$update storage.buckets set file_size_limit = 15728640,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'] where id = 'grading-photos'$q$;
  end if;
end $$;

-- Grading staff take, see and replace photos. Families never read the bucket: the "cb" function gives them a short-lived link.
drop policy if exists "grading photos read" on storage.objects;
drop policy if exists "grading photos add" on storage.objects;
drop policy if exists "grading photos change" on storage.objects;
drop policy if exists "grading photos remove" on storage.objects;
create policy "grading photos read"   on storage.objects for select to authenticated using (bucket_id = 'grading-photos' and public.prep_has_role('grading'));
create policy "grading photos add"    on storage.objects for insert to authenticated with check (bucket_id = 'grading-photos' and public.prep_has_role('grading'));
create policy "grading photos change" on storage.objects for update to authenticated using (bucket_id = 'grading-photos' and public.prep_has_role('grading')) with check (bucket_id = 'grading-photos' and public.prep_has_role('grading'));
create policy "grading photos remove" on storage.objects for delete to authenticated using (bucket_id = 'grading-photos' and public.prep_has_role('grading'));
