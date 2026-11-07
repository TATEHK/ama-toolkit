-- AMA ID Cards: database setup
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.
-- Safe to run more than once.

-- ---------- Tables ----------

create table if not exists public.people (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  dob         date,
  dan         text,
  issued      date,
  photo_path  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.settings (
  id               int primary key default 1 check (id = 1),
  issued_default   date,
  cert_text        text,
  sign_text        text,
  signature_path   text,
  front_path       text,
  require_approval boolean not null default true,
  updated_at       timestamptz not null default now()
);
alter table public.settings
  add column if not exists notify_topic text,
  add column if not exists notify_owner text,
  add column if not exists notify_url text;
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.print_jobs (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  created_by_email text default (auth.jwt() ->> 'email'),
  people_names     text[] not null default '{}',
  card_count       int not null default 0,
  sides            text not null default 'both' check (sides in ('both', 'back')),
  pdf_path         text not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'approved', 'printing', 'printed', 'failed', 'cancelled')),
  approved_by_email text,
  approved_at      timestamptz,
  printed_at       timestamptz,
  error            text
);
create index if not exists print_jobs_status_idx on public.print_jobs (status, created_at);

create table if not exists public.print_station (
  id           int primary key default 1 check (id = 1),
  last_seen    timestamptz,
  printer_name text,
  computer     text
);
insert into public.print_station (id) values (1) on conflict (id) do nothing;

-- ---------- Security: only signed-in staff can see or change anything ----------
-- (Turn off public sign-ups in Authentication settings so only people you add can sign in.)

alter table public.people        enable row level security;
alter table public.settings      enable row level security;
alter table public.print_jobs    enable row level security;
alter table public.print_station enable row level security;

drop policy if exists "staff full access" on public.people;
drop policy if exists "staff full access" on public.settings;
drop policy if exists "staff full access" on public.print_jobs;
drop policy if exists "staff full access" on public.print_station;

create policy "staff full access" on public.people        for all to authenticated using (true) with check (true);
create policy "staff full access" on public.settings      for all to authenticated using (true) with check (true);
create policy "staff full access" on public.print_jobs    for all to authenticated using (true) with check (true);
create policy "staff full access" on public.print_station for all to authenticated using (true) with check (true);

-- ---------- Private file storage for photos, signature and print files ----------

insert into storage.buckets (id, name, public)
values ('cards', 'cards', false)
on conflict (id) do nothing;

drop policy if exists "cards staff read"   on storage.objects;
drop policy if exists "cards staff insert" on storage.objects;
drop policy if exists "cards staff update" on storage.objects;
drop policy if exists "cards staff delete" on storage.objects;

create policy "cards staff read"   on storage.objects for select to authenticated using (bucket_id = 'cards');
create policy "cards staff insert" on storage.objects for insert to authenticated with check (bucket_id = 'cards');
create policy "cards staff update" on storage.objects for update to authenticated using (bucket_id = 'cards');
create policy "cards staff delete" on storage.objects for delete to authenticated using (bucket_id = 'cards');

-- ---------- Live updates between devices ----------

do $$
declare t text;
begin
  foreach t in array array['people', 'settings', 'print_jobs', 'print_station'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
