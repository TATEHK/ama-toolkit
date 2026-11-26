-- grading-event-6: grading events run inside the Grading Floor (the separate event app is gone), so Grading Floor
-- (Coloured Belts) logins count too: cb admin = everything (including approving results); cb results or days = roll call,
-- scoring, grading. Black Belt Gradings logins keep the access they had.
create or replace function public.ge_can(variadic perms text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_permissions p
                 where p.email = lower(auth.jwt() ->> 'email')
                   and ((p.app = 'bb' and (p.perm = any(perms) or p.perm = 'admin'))
                     or (p.app = 'cb' and (p.perm = 'admin'
                          or (p.perm in ('results', 'days') and perms && array['scoring', 'grading', 'results', 'attendance'])))))
$$;
create or replace function public.ge_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_permissions p where p.email = lower(auth.jwt() ->> 'email')
                 and (p.app = 'bb' or (p.app = 'cb' and p.perm in ('admin', 'results', 'days'))))
$$;
