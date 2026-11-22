-- Public (shared) grading-helper sign-up.
-- A single shared link (/grading/helpers/#join) lets eligible people find their own name and sign themselves
-- up to help, without being invited one by one. The eligible roster is the active black belts (from prep_students,
-- as the admin roster already uses) PLUS a hand-added "extras" list kept here on cb_helpers.
--
-- Extras are non-black-belts added by name in the helpers admin. They reuse the same 'manual:<slug>' member_key
-- scheme as helper_admin_assign, so an extra added here and the same person added to a day by hand are one record.
--
-- The shared link shows ONLY people already set up as helpers: the invited black belts plus the extras
-- (every active cb_helpers row). A visitor never sees the whole list — they type their own name and only
-- matches come back. Staff control the roster: black belts on the Invite tab, extras here.
--
-- Served by the cb edge function (service role):
--   helper_public_find (q)          (public)  search your own name (>=2 chars); returns matching active helpers only
--   helper_public_join (id)         (public)  hand back that helper's token so they see their day picker
--   helper_extras                   (staff)   list the extras (active and off)
--   helper_extra_set (name, ...)    (staff)   add / update / turn an extra on or off the link

alter table public.cb_helpers add column if not exists is_extra boolean not null default false;   -- a hand-added roster person (shows in the public picker)
alter table public.cb_helpers add column if not exists mobile text;                               -- optional contact for extras (not in EFC)
alter table public.cb_helpers add column if not exists email text;
create index if not exists cb_helpers_extra on public.cb_helpers(is_extra) where is_extra;
