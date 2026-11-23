-- App devices: one row per browser/device signed in to a staff login, so the Profile → Signed-in devices
-- page can list them, sign any one out, and mark a device "trusted" (exempt from the idle auto-logout).
-- Written by the client (idle-logout.js registers; the profile page reads/updates). RLS: a login only ever
-- sees and changes its own rows. Safe to run again.

create table if not exists public.app_devices (
  device_id    text primary key,
  user_id      uuid not null references auth.users on delete cascade,
  label        text,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  trusted      boolean not null default false,
  revoked_at   timestamptz
);
create index if not exists app_devices_user_idx on public.app_devices (user_id);

alter table public.app_devices enable row level security;

drop policy if exists app_devices_own_select on public.app_devices;
drop policy if exists app_devices_own_insert on public.app_devices;
drop policy if exists app_devices_own_update on public.app_devices;
drop policy if exists app_devices_own_delete on public.app_devices;
create policy app_devices_own_select on public.app_devices for select using (user_id = auth.uid());
create policy app_devices_own_insert on public.app_devices for insert with check (user_id = auth.uid());
create policy app_devices_own_update on public.app_devices for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy app_devices_own_delete on public.app_devices for delete using (user_id = auth.uid());

-- "Stay signed in on this device" (trusted = exempt from idle auto-logout) is for owners only — i.e. Tate.
-- Even though a login may update its own rows, only a toolkit owner may set trusted = true; anyone else's
-- attempt is quietly forced back to false, so shared office/reception devices can never be made to stay in.
create or replace function public.app_devices_owner_only_trust()
returns trigger language plpgsql security definer set search_path = public as $$
declare em text;
begin
  if new.trusted then
    begin em := lower(auth.jwt() ->> 'email'); exception when others then em := null; end;
    if em is null or not exists (select 1 from public.toolkit_owners where lower(email) = em) then
      new.trusted := false;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists app_devices_owner_only_trust on public.app_devices;
create trigger app_devices_owner_only_trust
  before insert or update on public.app_devices
  for each row execute function public.app_devices_owner_only_trust();
