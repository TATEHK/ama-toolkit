-- cb-private-days.sql (21 Nov 2026): a private grading day gets no automatic invites or booking texts, and is never
-- offered as another date. Students are added by hand. Set in Coloured Belts > edit a grading day > Private grading.
alter table public.cb_days add column if not exists private boolean not null default false;
update public.cb_days set private = true where day_id = '4d7ddbbe-96c7-48ec-b800-f1042ea09b2f';   -- Little Dragons, Wed 25 Nov, Marrickville
