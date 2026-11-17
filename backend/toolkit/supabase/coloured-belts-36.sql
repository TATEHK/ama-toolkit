-- Little Dragons nomination intake from the hub (coloured-belts-36).
-- The hub POSTs approved Little Dragons nominations to the cb function's `ld_nominate` action; the Toolkit
-- creates/updates the grading-day entries so the family pipeline (invite, book, pay, grade, result) runs.
--  - hook_key: shared secret the hub sends with each POST (checked against cb_settings.hook_key).
--  - ld_nomination_id: the hub's stable id for a nomination, stored on the entry for tracing (non-null = from the hub).
alter table public.cb_settings add column if not exists hook_key text;
update public.cb_settings
  set hook_key = translate(left(encode(decode(replace(gen_random_uuid()::text,'-',''),'hex'),'base64'),22),'+/','-_')
  where id=1 and (hook_key is null or hook_key='');
alter table public.cb_entries add column if not exists ld_nomination_id text;
