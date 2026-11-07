-- Black Belt Prep: update 13 (EFC Aquila member contacts)
-- Run once in Supabase > SQL Editor, after prep-update-12.sql. Safe to run again.
-- A copy of EFC Aquila members and leads (names and family contact details), sent in by Zapier through the
-- "efc" Supabase function, or loaded from an Aquila export. Staff search it by name to find contact details.
-- EFC stays the master copy: nothing here is sent back to EFC.

create table if not exists public.efc_members (
  member_key     text primary key,                 -- EFC's member ID when it sends one, else name + phone/email
  kind           text not null default 'member' check (kind in ('member', 'lead')),
  full_name      text not null,
  first_name     text,
  last_name      text,
  phone          text,
  email          text,
  guardian_name  text,
  guardian_phone text,
  guardian_email text,
  date_of_birth  text,
  status         text,
  location       text,
  raw            jsonb not null default '{}'::jsonb, -- everything EFC sent, in case a field is needed later
  source         text not null default 'zapier',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists efc_members_name_idx on public.efc_members (lower(full_name));
alter table public.efc_members add column if not exists efc_reference text;      -- EFC's member number (e.g. AU-023-19052)
alter table public.efc_members add column if not exists attendance_total int;    -- total classes attended, as EFC counts them
alter table public.efc_members add column if not exists last_attended date;
alter table public.efc_members add column if not exists programme text;           -- from EFC's Assessment Query (e.g. Taekwondo)
alter table public.efc_members add column if not exists belt text;                -- current belt in that programme
alter table public.efc_members add column if not exists promoted_on date;         -- last grading
alter table public.efc_members add column if not exists attended_since_promoted int;   -- classes since last grading
alter table public.efc_members add column if not exists ready_to_promote boolean;

alter table public.efc_members enable row level security;
drop policy if exists "read" on public.efc_members;
-- Contact details: admins, instructors and grading staff only
create policy "read" on public.efc_members for select to authenticated using (public.prep_has_role('instructor', 'grading'));
revoke all on public.efc_members from anon;
grant select on public.efc_members to authenticated;

-- The secret Zapier puts in the webhook address. Only the "efc" function (service role) can read it.
create table if not exists public.efc_hook (
  id         int primary key default 1 check (id = 1),
  secret     text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);
insert into public.efc_hook (id) values (1) on conflict (id) do nothing;
alter table public.efc_hook enable row level security;
revoke all on public.efc_hook from anon, authenticated;

-- Search by part of a name (student or parent), phone or email
create or replace function public.efc_search(p_q text, p_limit int default 20)
returns setof public.efc_members language sql stable security invoker set search_path = public as $$
  select * from public.efc_members m
   where length(trim(coalesce(p_q, ''))) >= 2
     and (m.full_name ilike '%' || trim(p_q) || '%' or m.guardian_name ilike '%' || trim(p_q) || '%'
          or m.email ilike '%' || trim(p_q) || '%' or m.guardian_email ilike '%' || trim(p_q) || '%'
          or (length(regexp_replace(p_q, '\D', '', 'g')) >= 4
              and regexp_replace(coalesce(m.phone, '') || ' ' || coalesce(m.guardian_phone, ''), '\D', '', 'g') like '%' || regexp_replace(p_q, '\D', '', 'g') || '%'))
   order by (m.kind = 'member') desc, m.full_name
   limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;
revoke all on function public.efc_search(text, int) from public, anon;
grant execute on function public.efc_search(text, int) to authenticated;
