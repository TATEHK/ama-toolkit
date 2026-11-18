-- Per-student grading-fee discount (coloured-belts-37).
-- A dollar amount off one entry's grading fee. At card checkout the cb function turns it into a Stripe
-- coupon, so the family sees a real "Discount -$X" line on the Stripe page (subtotal, discount, total)
-- instead of a silently lowered price. Staff set it per student; 0 = no discount.
--  - discount: dollars off the base fee (>= 0; the function clamps it to at most the fee).
--  - discount_reason: short label shown on the Stripe discount line (e.g. "Sibling discount").
alter table public.cb_entries add column if not exists discount numeric not null default 0;
alter table public.cb_entries add column if not exists discount_reason text;
