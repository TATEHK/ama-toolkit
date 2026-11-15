-- prep-update-29.sql: black belt grading helper messaging to match Tate's spec.
--  - prep_helpers.sword_slot: for a student going for 4th Dan, the one session where their sword is presented
--    (chosen when they confirm, balancing the three sessions towards an even ~6/6/6 split). Named in their
--    confirmation ("...at the 12:00pm session.") and in the Friday reminder.
--  - confirm_text: add the arrival + uniform line ("Please arrive 15-30 minutes before in full uniform.").
--  - The invite/reply/sword wording and the fixed session numbering (1 = 8:00am, 2 = 12:00pm, 3 = 3:30pm in
--    every message) live in the nurture + cb functions; the {sword} and {reply} tokens are filled there.
--  - The Friday reminder (the day before grading) is sent by the nurture scheduled run, logged once per helper
--    in prep_nurture_log as step_code 'helper_reminder'.

alter table public.prep_helpers add column if not exists sword_slot uuid;

update public.prep_helper_settings
  set confirm_text = E'Thanks {first_name}! You''re helping at the {sessions} on {day} at AMA Sydenham.{full_note}{sword} Please arrive 15-30 minutes before in full uniform. See you there! - AMA',
      updated_at = now()
  where id = 1;
