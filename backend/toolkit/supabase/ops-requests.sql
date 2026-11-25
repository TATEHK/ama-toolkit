-- Operations requests: staff can request staff rostering for a grading, or report a problem to fix.
-- They land in the Operations dashboard (cb_ops_dashboard -> 'requests') for Mark/admins to approve or resolve.
-- Submit needs the Operations permission ('ops'); approving/resolving needs 'admin'.

create table if not exists public.cb_ops_requests (
  request_id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('roster','problem')),
  day_id uuid references public.cb_days(day_id) on delete set null,   -- the grading, for a rostering request
  title text not null,
  details text,
  requested_by_email text,
  requested_by_name text,
  status text not null default 'open' check (status in ('open','approved','declined','done')),
  resolved_by text,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz not null default now()
);
alter table public.cb_ops_requests enable row level security;   -- access is through the security-definer RPCs below

-- submit a request (staff rostering for a grading, or a problem to fix). Needs Operations access.
create or replace function public.cb_ops_request_create(p_kind text, p_day_id uuid, p_title text, p_details text, p_name text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.cb_ops_requests%rowtype;
begin
  if not public.cb_has_cb(array['ops']) then raise exception 'not allowed' using errcode='42501'; end if;
  if p_kind not in ('roster','problem') then raise exception 'bad kind'; end if;
  if coalesce(btrim(p_title),'')='' then raise exception 'title required'; end if;
  insert into public.cb_ops_requests(kind, day_id, title, details, requested_by_email, requested_by_name)
    values (p_kind, case when p_kind='roster' then p_day_id end, left(btrim(p_title),200), nullif(left(coalesce(p_details,''),2000),''),
            nullif(auth.jwt()->>'email',''), nullif(left(coalesce(p_name,''),120),''))
    returning * into r;
  return to_jsonb(r);
end $$;
grant execute on function public.cb_ops_request_create(text, uuid, text, text, text) to authenticated;

-- approve / decline / mark done / reopen a request. Needs admin (Mark / owners).
create or replace function public.cb_ops_request_resolve(p_request_id uuid, p_status text, p_resolution text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.cb_ops_requests%rowtype;
begin
  if not public.cb_has_cb(array['admin']) then raise exception 'not allowed' using errcode='42501'; end if;
  if p_status not in ('open','approved','declined','done') then raise exception 'bad status'; end if;
  update public.cb_ops_requests set
    status = p_status,
    resolution = nullif(left(coalesce(p_resolution,''),2000),''),
    resolved_by = case when p_status='open' then null else nullif(auth.jwt()->>'email','') end,
    resolved_at = case when p_status='open' then null else now() end
  where request_id = p_request_id returning * into r;
  if not found then return jsonb_build_object('error','not_found'); end if;
  return to_jsonb(r);
end $$;
grant execute on function public.cb_ops_request_resolve(uuid, text, text) to authenticated;
