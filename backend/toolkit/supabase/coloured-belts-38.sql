-- Percentage grading-fee discounts (coloured-belts-38).
-- Adds a kind to the per-entry discount from coloured-belts-37: staff can take either a dollar amount or a
-- percentage off. `discount` holds the number they entered; `discount_kind` says how to read it.
--  - discount_kind = 'amount'  -> `discount` is dollars off the fee.
--  - discount_kind = 'percent' -> `discount` is a percentage off (0-100).
-- At card checkout the cb function makes a Stripe coupon (amount_off or percent_off) so the family sees a
-- real "Discount" line on the Stripe page.
alter table public.cb_entries add column if not exists discount_kind text not null default 'amount';
