-- Black Belt Prep: update 11 (text messages through GoHighLevel)
-- Run once in Supabase > SQL Editor, after prep-update-10.sql. Safe to run again.
-- Staff send grading invitations, congratulations, "not ready yet" messages and essay links as texts through
-- GoHighLevel (the "ghl" Supabase function sends them). Nothing is sent automatically: a person picks who, checks
-- the wording and presses Send. Every text is logged.

-- The wording for each kind of message (admins change it in Settings). Placeholders are filled in for each student:
-- {first_name} {name} {belt} (the belt they're going for) {current_belt} {grading_date} {link} {reason}
create table if not exists public.prep_message_templates (
  kind       text primary key check (kind in ('invite', 'congrats', 'not_ready', 'essay')),
  body       text not null check (length(trim(body)) between 1 and 1000),
  updated_at timestamptz not null default now()
);
insert into public.prep_message_templates (kind, body) values
  ('invite', 'Hi! {first_name} is invited to grade for {belt} on {grading_date}. Please book and pay here: {link} - AMA Marrickville'),
  ('congrats', 'Congratulations {first_name}! You passed your grading and are now a {belt}. We are so proud of you. - AMA Marrickville'),
  ('not_ready', 'Hi! {first_name} is working hard towards {belt}. Before grading, our instructors would like to see {reason}, and we will help get there. Keep up the great training! - AMA Marrickville'),
  ('essay', 'Hi {first_name}, here is your personal link for your black belt essay ({belt}): {link} - AMA Marrickville')
on conflict (kind) do nothing;

-- Booking and payment link for a cycle's grading (e.g. a GoHighLevel calendar or payment link)
alter table public.prep_cycles add column if not exists invite_link text;

-- Every text sent (or that failed), written by the "ghl" function
create table if not exists public.prep_messages (
  message_id     uuid primary key default gen_random_uuid(),
  student_id     text references public.prep_students on update cascade on delete cascade,
  cycle_id       uuid references public.prep_cycles on delete set null,
  kind           text not null,
  to_phone       text,
  body           text not null,
  status         text not null check (status in ('sent', 'failed', 'test')),
  error          text,
  ghl_contact_id text,
  ghl_message_id text,
  sent_by        text,
  sent_at        timestamptz not null default now()
);
create index if not exists prep_messages_student_idx on public.prep_messages (student_id, sent_at desc);

alter table public.prep_message_templates enable row level security;
alter table public.prep_messages enable row level security;
drop policy if exists "read" on public.prep_message_templates;
drop policy if exists "write" on public.prep_message_templates;
create policy "read"  on public.prep_message_templates for select to authenticated using (public.prep_can_view());
create policy "write" on public.prep_message_templates for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
drop policy if exists "read" on public.prep_messages;
create policy "read" on public.prep_messages for select to authenticated using (public.prep_has_role('instructor', 'grading'));
grant select, insert, update, delete on public.prep_message_templates to authenticated;
grant select on public.prep_messages to authenticated;
drop trigger if exists prep_message_templates_audit on public.prep_message_templates;
create trigger prep_message_templates_audit after insert or update or delete on public.prep_message_templates
  for each row execute function public.prep_audit('kind');
