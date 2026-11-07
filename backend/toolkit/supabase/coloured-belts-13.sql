-- AMA Toolkit: coloured belt grading, update 13 (live updates)
-- Run once in Supabase > SQL Editor, after coloured-belts-12.sql. Safe to run again.
-- Changes made by one staff member (results, check-in, bookings, grading days, Black Belt Club invitations, contacts)
-- show up straight away for everyone else with Gradings open. Each person only gets changes they're allowed to read.
do $$
declare t text;
begin
  foreach t in array array['cb_entries', 'cb_days', 'efc_members', 'cb_approvals'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
