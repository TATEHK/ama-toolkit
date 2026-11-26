-- grading-event-2: the gevent function's seed key (loads a bundled event config). The key lives in the vault only.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'ge_seed_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'ge_seed_key', 'gevent: load a bundled grading event config');
  end if;
end $$;
create or replace function public.ge_seed_ok(p_key text) returns boolean
language plpgsql stable security definer set search_path = public, vault as $$
begin
  return coalesce(p_key <> '' and p_key = (select decrypted_secret from vault.decrypted_secrets where name = 'ge_seed_key' limit 1), false);
end $$;
revoke all on function public.ge_seed_ok(text) from public, anon, authenticated;
grant execute on function public.ge_seed_ok(text) to service_role;
