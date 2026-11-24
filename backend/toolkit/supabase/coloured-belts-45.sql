-- coloured-belts-45: a dedicated "Makeup date" text, sent when a student is moved to a makeup grading day.
-- Previously the move reused the "Reminder to book" text; now it has its own wording, editable in Settings.

alter table public.cb_settings add column if not exists makeup_text text
  not null default 'Hi {parent}, thanks for letting us know {first} can''t make their grading. We''ve been able to organise a once-off makeup grading date: {date}{time}, {school}. Book and confirm their spot here: {link}';

update public.cb_settings
   set makeup_text = 'Hi {parent}, thanks for letting us know {first} can''t make their grading. We''ve been able to organise a once-off makeup grading date: {date}{time}, {school}. Book and confirm their spot here: {link}'
 where makeup_text is null or btrim(makeup_text) = '';
