-- coloured-belts-44: student profile photos, auto-cropped from grading photos, for Mark's hub.
--
-- The grading app crops the student's face out of their grading photo (the one taken with Grandmaster,
-- Grandmaster removed) and stores the crop here. The hub pulls them with the 'profile_photos' feed action
-- in the cb function (cb_settings.hook_key), exactly like the Black Belt Club sign-ups feed.

-- Grandmaster's face embedding (array of ~128 numbers), set once from the grading app's Settings screen.
-- The crop drops whichever detected face matches this; whatever's left is the student.
alter table public.cb_settings add column if not exists gm_face_descriptor jsonb;
alter table public.cb_settings add column if not exists gm_enrolled_at     timestamptz;

-- One cropped profile photo per student (the latest grading photo wins). path = profile-photos/<member_key>.jpg
create table if not exists public.cb_profile_photos (
  member_key      text primary key,
  full_name       text,
  path            text not null,
  source_entry_id uuid references public.cb_entries(entry_id) on delete set null,
  source_photo_at timestamptz,
  feed_seen_at    timestamptz,          -- the hub has pulled this version
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.cb_profile_photos enable row level security;
drop policy if exists "read"  on public.cb_profile_photos;
create policy "read"  on public.cb_profile_photos for select to authenticated using (public.prep_has_role('instructor','grading','payments'));
drop policy if exists "write" on public.cb_profile_photos;
create policy "write" on public.cb_profile_photos for all to authenticated using (public.prep_has_role('grading')) with check (public.prep_has_role('grading'));

-- Private storage bucket for the crops. Grading staff read/write; the hub never reads it directly
-- (the cb 'profile_photos' feed hands out short-lived signed URLs, and the hub saves its own copy).
insert into storage.buckets (id, name, public) values ('profile-photos', 'profile-photos', false)
  on conflict (id) do update set public = false;
drop policy if exists "profile photos read"   on storage.objects;
drop policy if exists "profile photos add"    on storage.objects;
drop policy if exists "profile photos change" on storage.objects;
drop policy if exists "profile photos remove" on storage.objects;
create policy "profile photos read"   on storage.objects for select to authenticated using (bucket_id = 'profile-photos' and public.prep_has_role('grading'));
create policy "profile photos add"    on storage.objects for insert to authenticated with check (bucket_id = 'profile-photos' and public.prep_has_role('grading'));
create policy "profile photos change" on storage.objects for update to authenticated using (bucket_id = 'profile-photos' and public.prep_has_role('grading')) with check (bucket_id = 'profile-photos' and public.prep_has_role('grading'));
create policy "profile photos remove" on storage.objects for delete to authenticated using (bucket_id = 'profile-photos' and public.prep_has_role('grading'));
