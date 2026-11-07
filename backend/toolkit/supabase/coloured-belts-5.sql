-- AMA Toolkit: coloured belt grading, update 5 (short photo links, so a photo text fits in one SMS)
-- Run once in Supabase > SQL Editor, after coloured-belts-4.sql. Safe to run again.
-- Each student on a grading day gets a short random code for their photo link: theggatonklenner.github.io/p#<code>

-- 10 letters and digits from a random UUID (about 59 bits: not guessable)
create or replace function public.cb_short_code(n int default 10) returns text language plpgsql volatile as $$
declare a text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; b bytea; s text := '';
begin
  b := decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex');
  for i in 0 .. n - 1 loop s := s || substr(a, 1 + (get_byte(b, i) % length(a)), 1); end loop;
  return s;
end $$;

alter table public.cb_entries add column if not exists photo_code text;
update public.cb_entries set photo_code = public.cb_short_code() where photo_code is null;
alter table public.cb_entries alter column photo_code set default public.cb_short_code();
alter table public.cb_entries alter column photo_code set not null;
create unique index if not exists cb_entries_photo_code_idx on public.cb_entries (photo_code);

-- A shorter photo text (under 160 characters with the link, for most names)
alter table public.cb_settings alter column photo_text set default 'Hi {parent}, here''s {first}''s grading photo with the Grandmaster: {photo} AMA {school}';
update public.cb_settings set photo_text = 'Hi {parent}, here''s {first}''s grading photo with the Grandmaster: {photo} AMA {school}'
 where photo_text = 'Hi {parent}, here is {first}''s photo with the Grandmaster from their grading. Congratulations on their {next}! {photo} AMA {school}';
