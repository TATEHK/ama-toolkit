-- Black Belt Prep: update 26 (Masters Club uniform + black belt polo combo)
-- Run once in Supabase > SQL Editor, after prep-update-25.sql. Safe to run again.
-- A family's polo link can add a Masters Club uniform: the combo is one uniform and one polo for a set price
-- (default $150); any extra polos are the normal polo price each. Staff set the combo price, the uniform sizes
-- and whether the combo is offered in Polo shirts > Settings.

alter table public.prep_polo_settings add column if not exists combo_on boolean not null default true;
alter table public.prep_polo_settings add column if not exists combo_price numeric(8,2) not null default 150 check (combo_price >= 0);
alter table public.prep_polo_settings add column if not exists uniform_sizes text[] not null
  default array['0000', '000', '00', '0', '1', '2', '3', '4', '5', '6', '7'];

alter table public.prep_polo_orders add column if not exists uniform boolean not null default false;   -- the combo: a Masters Club uniform with the polo
alter table public.prep_polo_orders add column if not exists uniform_size text;
alter table public.prep_polo_orders add column if not exists uniform_price numeric(8,2);             -- the combo price when they paid
