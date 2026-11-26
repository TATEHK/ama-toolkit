-- bb-oath-1: digital Black Belt Oath.
-- Each person who passes to Probationary Black Belt gets a private signing link (token). The signed oath
-- (typed name, drawn signature, date) is stored here, with the signature PNG in the private "bb-oath" bucket.
-- Mark's hub (AMA OS) reads it through the ama_os_app login: SELECT on bb_oath (every column except the token)
-- and read on the bucket's objects.

create table if not exists public.bb_oath (
  oath_id        uuid primary key default gen_random_uuid(),
  member_key     text not null,                      -- efc_members.member_key ("efc:<uuid>")
  efc_reference  text,                               -- e.g. AU-023-17406, for matching in the hub
  full_name      text,                               -- name on record when the link was made
  rank           text not null default 'Probationary Black Belt',
  entry_id       uuid references public.cb_entries(entry_id) on delete set null,
  day_id         uuid references public.cb_days(day_id) on delete set null,
  prep_cycle_id  uuid,
  grading_date   date,
  token          text not null unique,               -- the private signing link; never shown to the hub
  sent_at        timestamptz,
  sent_to        text,
  send_error     text,
  name           text,                               -- what they typed after "I,"
  signature_path text,                               -- bb-oath/<path>.png
  signature_png  text,                               -- the same image as a data: URL, so the hub can show it without Storage
  signed_at      timestamptz,
  signed_date    date,                               -- the date shown on the oath (Sydney)
  oath_version   text not null default '2026-11',
  signed_ua      text,
  created_at     timestamptz not null default now(),
  unique (member_key, day_id)
);
create index if not exists bb_oath_member on public.bb_oath (member_key);
create index if not exists bb_oath_ref on public.bb_oath (efc_reference);

alter table public.bb_oath enable row level security;
-- No anon access: the signing page goes through the bboath edge function (service role).
-- Toolkit staff with grading results access can read.
drop policy if exists "bb oath staff read" on public.bb_oath;
create policy "bb oath staff read" on public.bb_oath for select to authenticated
  using (exists (select 1 from public.app_permissions p
                 where p.email = lower(auth.jwt() ->> 'email') and p.app = 'cb' and p.perm in ('admin', 'results', 'text_result')));

-- Mark's hub (AMA OS): read-only, every column except the token.
revoke all on public.bb_oath from ama_os_app;
grant select (oath_id, member_key, efc_reference, full_name, rank, entry_id, day_id, prep_cycle_id, grading_date,
              sent_at, name, signature_path, signature_png, signed_at, signed_date, oath_version, created_at)
  on public.bb_oath to ama_os_app;
drop policy if exists "bb oath ama os read" on public.bb_oath;
create policy "bb oath ama os read" on public.bb_oath for select to ama_os_app using (true);

-- Signature images: private bucket, PNG only, 512 KB cap.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bb-oath', 'bb-oath', false, 524288, array['image/png'])
on conflict (id) do update set public = false, file_size_limit = 524288, allowed_mime_types = array['image/png'];

drop policy if exists "bb oath read" on storage.objects;
create policy "bb oath read" on storage.objects for select to authenticated
  using (bucket_id = 'bb-oath' and exists (select 1 from public.app_permissions p
         where p.email = lower(auth.jwt() ->> 'email') and p.app = 'cb' and p.perm in ('admin', 'results', 'text_result')));

grant usage on schema storage to ama_os_app;
grant select on storage.objects to ama_os_app;
drop policy if exists "bb oath ama os read" on storage.objects;
create policy "bb oath ama os read" on storage.objects for select to ama_os_app using (bucket_id = 'bb-oath');
