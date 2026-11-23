-- coloured-belts-42: secure the Black Belt Club welcome-flow tables, and let grading staff read them.
--
-- cb_bbc_flow and cb_bbc_steps shipped in coloured-belts-40 without row-level security, so the public
-- anon key could read every student's welcome-flow row — including their landing-page token (which is the
-- secret behind their personal /black-belt-club/#t=<token> enrol link), full name, phone and email.
-- Enable RLS and allow only signed-in grading staff to read. Writes stay service-role only:
-- the welcome-flow cron and the landing page's bbc_info / bbc_signup actions run as the service role,
-- which bypasses RLS, so they are unaffected. The app's new "welcome sequence" view reads through this policy.

alter table public.cb_bbc_flow  enable row level security;
alter table public.cb_bbc_steps enable row level security;

drop policy if exists "read" on public.cb_bbc_flow;
create policy "read" on public.cb_bbc_flow
  for select to authenticated using (public.prep_has_role('instructor', 'grading', 'payments'));

drop policy if exists "read" on public.cb_bbc_steps;
create policy "read" on public.cb_bbc_steps
  for select to authenticated using (public.prep_has_role('instructor', 'grading', 'payments'));
