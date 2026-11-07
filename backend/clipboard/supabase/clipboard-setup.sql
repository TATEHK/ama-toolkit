-- Clipboard templates: database setup
-- Run in Supabase > SQL Editor (choose "with RLS" if asked). Safe to run again; running it again
-- after an earlier version switches the templates to one shared library (nothing is lost).
--
-- One shared library: everyone with an AMA staff login (anyone with a permission in AMA ID Cards,
-- other than the print station, or a role in Black Belt Prep) can see, copy, add, edit and delete
-- every template. Each template records who added it and who last changed it.

create table if not exists public.clip_templates (
  id           uuid primary key default gen_random_uuid(),
  owner        text not null default lower(auth.jwt() ->> 'email'),   -- who added it
  title        text not null check (length(trim(title)) > 0),
  body         text not null default '',
  category     text,
  pinned       boolean not null default false,
  use_count    int not null default 0,
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.clip_templates add column if not exists updated_by text;
create index if not exists clip_templates_owner_idx on public.clip_templates (owner);

-- Who added it never changes; who last changed it is recorded
create or replace function public.clip_stamp() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.owner := lower(auth.jwt() ->> 'email');
    new.updated_by := new.owner;
  else
    new.owner := old.owner;
    if (new.title, new.body, new.category, new.pinned) is distinct from (old.title, old.body, old.category, old.pinned) then
      new.updated_at := now();
      new.updated_by := lower(auth.jwt() ->> 'email');
    else
      new.updated_by := old.updated_by;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists clip_stamp on public.clip_templates;
create trigger clip_stamp before insert or update on public.clip_templates
  for each row execute function public.clip_stamp();

-- AMA staff: a permission in AMA ID Cards (not just the print station) or a role in Black Belt Prep
create or replace function public.clip_is_staff() returns boolean
  language plpgsql stable security definer set search_path = public as $$
declare me text := lower(auth.jwt() ->> 'email'); yes boolean := false;
begin
  if me is null then return false; end if;
  if to_regclass('public.staff_permissions') is not null then
    execute 'select exists (select 1 from public.staff_permissions where email = $1 and permission <> ''printer'')' into yes using me;
    if yes then return true; end if;
  end if;
  if to_regclass('public.prep_roles') is not null then
    execute 'select exists (select 1 from public.prep_roles where email = $1)' into yes using me;
  end if;
  return yes;
end $$;
grant execute on function public.clip_is_staff() to authenticated;

alter table public.clip_templates enable row level security;
drop policy if exists "own templates" on public.clip_templates;
drop policy if exists "staff share templates" on public.clip_templates;
create policy "staff share templates" on public.clip_templates for all to authenticated
  using (public.clip_is_staff())
  with check (public.clip_is_staff());

-- Count a copy (for "most used" ordering)
create or replace function public.clip_used(p_id uuid) returns void
  language sql security invoker set search_path = public as $$
  update public.clip_templates set use_count = use_count + 1, last_used_at = now() where id = p_id
$$;
grant execute on function public.clip_used(uuid) to authenticated;
