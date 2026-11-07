-- AMA Toolkit: coloured belt grading, update 17 (short booking links)
-- Run once in Supabase > SQL Editor, after coloured-belts-16.sql. Safe to run again.
--
-- Booking links were long: app.train-ama.com/grading/coloured-belts/book/#t=<64 hex chars>.
-- Now they are short, like the essay links: app.train-ama.com/b#<12 url-safe chars> (a /b/ page
-- redirects to the booking page). New entries get a 12-char token; this also shortens the token on
-- every entry that hasn't graded yet, so links going out for the December cycle are short. The "cb"
-- function accepts both the short tokens and any old 64-hex ones still in circulation.

-- New short default (12 url-safe chars from a random uuid), same shape as the essay tokens
alter table public.cb_entries
  alter column token set default translate(left(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), 12), '+/', '-_');

-- Shorten the token on entries that haven't graded yet (keeps already-graded records untouched)
update public.cb_entries
  set token = translate(left(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), 12), '+/', '-_')
  where result is null;
