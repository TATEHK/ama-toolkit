-- AMA Toolkit: coloured belt grading, update 6 (grading photos removed after 30 days; nightly EFC update)
-- Run once in Supabase > SQL Editor, after coloured-belts-5.sql. Safe to run again.

-- ---------- Grading photos: removed 30 days after they're taken ----------
alter table public.cb_entries add column if not exists photo_removed_at timestamptz;

-- Photos older than 30 days (the "cb" function deletes them through the Storage API; storage rows can't be deleted with SQL)
create or replace function public.cb_old_photos(p_days int default 30)
returns setof text language plpgsql stable security definer set search_path = public, storage as $$
begin
  return query select o.name from storage.objects o where o.bucket_id = 'grading-photos' and o.created_at < now() - make_interval(days => p_days) order by o.created_at limit 1000;
end $$;
-- After deleting: the student's photo is gone, and the family's link says so
create or replace function public.cb_photos_removed(p_names text[])
returns int language sql security definer set search_path = public as $$
  with u as (update cb_entries set photo_path = null, photo_removed_at = now() where photo_path = any (p_names) returning 1) select count(*)::int from u
$$;
-- The nightly job proves itself to the "cb" function with a secret kept in Supabase Vault (no one needs to see it)
create or replace function public.cb_cron_ok(p_secret text)
returns boolean language plpgsql stable security definer set search_path = public, vault as $$
begin
  return coalesce(p_secret <> '' and p_secret = (select decrypted_secret from vault.decrypted_secrets where name = 'cb_cron_secret' limit 1), false);
end $$;
revoke all on function public.cb_old_photos(int), public.cb_photos_removed(text[]), public.cb_cron_ok(text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.cb_old_photos(int), public.cb_photos_removed(text[]), public.cb_cron_ok(text) to service_role;
  end if;
end $$;

-- ---------- Nightly EFC update ----------
-- Each night EFC's Assessment Query (through Zapier) is loaded for every program and school. Rows are
-- [member_id, grade, promoted (date), attended since promoted]. Taekwondo updates the member (Black Belt Gradings
-- reads it there; it copies across to efc_grades); other programs update efc_grades. Returns the member IDs EFC has that
-- aren't here yet, so their names and contacts can be added with cb_load_efc.
create table if not exists public.cb_efc_runs (
  run_id    bigint generated always as identity primary key,
  programme text not null,
  location  text,
  rows      int not null,
  new_ids   int not null default 0,
  ran_at    timestamptz not null default now()
);
alter table public.cb_efc_runs enable row level security;
drop policy if exists "read" on public.cb_efc_runs;
create policy "read" on public.cb_efc_runs for select to authenticated using (public.prep_has_role('instructor', 'grading', 'payments'));
revoke all on public.cb_efc_runs from anon;
grant select on public.cb_efc_runs to authenticated;

create or replace function public.cb_efc_update(p_prog text, p_loc text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; k text; missing jsonb := '[]'::jsonb; n int := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    k := 'efc:' || (r->>0);
    if not exists (select 1 from efc_members where member_key = k) then missing := missing || to_jsonb(r->>0); continue; end if;
    if p_prog = 'Taekwondo' then
      update efc_members set belt = r->>1, promoted_on = nullif(r->>2, '')::date, attended_since_promoted = nullif(r->>3, '')::int, updated_at = now()
       where member_key = k and (belt is distinct from r->>1 or promoted_on is distinct from nullif(r->>2, '')::date or attended_since_promoted is distinct from nullif(r->>3, '')::int);
    else
      insert into efc_grades (member_key, programme, belt, promoted_on, attended_since_promoted, updated_at)
      values (k, p_prog, r->>1, nullif(r->>2, '')::date, nullif(r->>3, '')::int, now())
      on conflict (member_key, programme) do update set belt = excluded.belt, promoted_on = excluded.promoted_on,
        attended_since_promoted = excluded.attended_since_promoted, updated_at = now()
       where efc_grades.belt is distinct from excluded.belt or efc_grades.promoted_on is distinct from excluded.promoted_on
          or efc_grades.attended_since_promoted is distinct from excluded.attended_since_promoted;
    end if;
    n := n + 1;
  end loop;
  insert into cb_efc_runs (programme, location, rows, new_ids) values (p_prog, p_loc, jsonb_array_length(p_rows), jsonb_array_length(missing));
  return jsonb_build_object('updated', n, 'missing', missing);
end $$;
revoke all on function public.cb_efc_update(text, text, jsonb) from public, anon, authenticated;

-- ---------- The daily photo clean-up job (Supabase only: needs pg_cron, pg_net and Vault) ----------
-- Every night at about 3am Sydney time, ask the "cb" function to delete photos older than 30 days.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net')
     and exists (select 1 from pg_extension where extname = 'supabase_vault') then
    if not exists (select 1 from vault.secrets where name = 'cb_cron_secret') then
      perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'cb_cron_secret', 'Lets the nightly job call the cb function');
    end if;
    perform cron.schedule('cb-photo-cleanup', '17 16 * * *', $job$
      select net.http_post(url := 'https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/cb',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cb-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'cb_cron_secret')),
        body := '{"action":"cleanup"}'::jsonb)
    $job$);
  end if;
end $$;
