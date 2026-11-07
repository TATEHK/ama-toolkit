-- AMA Toolkit: session controls — force sign-out.
-- Run once in Supabase > SQL Editor. Safe to run again.
-- Deletes a login's refresh sessions so they're signed out on every device (takes effect within the
-- access-token lifetime, i.e. up to the project's JWT expiry). Only the service-role "staff" function runs it.

create or replace function public.force_signout(p_email text)
returns integer language plpgsql security definer set search_path = auth, public as $$
declare uid uuid; n integer;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then return 0; end if;
  delete from auth.sessions where user_id = uid;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.force_signout(text) from anon, authenticated;
