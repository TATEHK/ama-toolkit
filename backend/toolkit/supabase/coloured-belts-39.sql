-- Discount note + exact discount label (coloured-belts-39).
-- Builds on the per-entry discount (37/38). Two refinements for gifts like the staff thank-you:
--  - discount_reason now shows on the Stripe discount line verbatim (no "Discount:" prefix), so a label like
--    "Staff Gift - 30% off" appears exactly as typed.
--  - discount_note: an optional short message shown with the discount - above the Pay button on Stripe
--    (checkout custom_text) and under the discount on our own booking page.
alter table public.cb_entries add column if not exists discount_note text;
