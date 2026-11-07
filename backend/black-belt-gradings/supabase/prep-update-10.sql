-- Black Belt Prep: update 10 (essays)
-- Run once in Supabase > SQL Editor, after prep-update-09.sql. Safe to run again.
-- Students going for a Dan (1st Dan and up) write an essay; Probationary Black Belt has none. Each gets a personal link (no login)
-- to paste their essay and/or upload a file (PDF, Word, or a photo). Admins and instructors read them,
-- mark them reviewed, or send them back with feedback for the student to change and hand in again.

-- The question (and an optional minimum word count) for each belt being graded to
create table if not exists public.prep_essay_questions (
  target_rank text primary key,
  question    text not null check (length(trim(question)) > 0),
  min_words   int check (min_words is null or min_words between 1 and 20000),
  updated_at  timestamptz not null default now()
);

-- When essays are due in a cycle (empty: no due date)
alter table public.prep_cycles add column if not exists essay_due date;

-- One essay per student per cycle. The token is the secret part of their personal link.
create table if not exists public.prep_essays (
  essay_id      uuid primary key default gen_random_uuid(),
  cycle_id      uuid not null,
  student_id    text not null,
  target_rank   text not null,
  token         text not null unique,
  status        text not null default 'not_submitted' check (status in ('not_submitted', 'submitted', 'needs_changes', 'reviewed')),
  body          text check (body is null or length(body) <= 200000),
  word_count    int not null default 0,
  file_path     text,
  file_name     text,
  file_type     text,
  submitted_at  timestamptz,
  version       int not null default 0,
  mark          text check (mark is null or length(mark) <= 60),
  feedback      text check (feedback is null or length(feedback) <= 5000),
  reviewed_by   text,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (cycle_id, student_id),
  foreign key (cycle_id, student_id) references public.prep_enrolments (cycle_id, student_id) on delete cascade
);

-- Earlier versions, kept when a student hands in again
create table if not exists public.prep_essay_versions (
  essay_id     uuid not null references public.prep_essays on delete cascade,
  version      int not null,
  body         text,
  word_count   int,
  file_path    text,
  file_name    text,
  file_type    text,
  submitted_at timestamptz,
  feedback     text,
  primary key (essay_id, version)
);

alter table public.prep_essay_questions enable row level security;
alter table public.prep_essays enable row level security;
alter table public.prep_essay_versions enable row level security;
drop policy if exists "read" on public.prep_essay_questions;
drop policy if exists "write" on public.prep_essay_questions;
create policy "read"  on public.prep_essay_questions for select to authenticated using (public.prep_can_view());
create policy "write" on public.prep_essay_questions for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
-- Essays are seen only by admins and instructors (students reach their own through their link)
drop policy if exists "read" on public.prep_essays;
drop policy if exists "mark" on public.prep_essays;
create policy "read" on public.prep_essays for select to authenticated using (public.prep_has_role('instructor'));
create policy "mark" on public.prep_essays for update to authenticated using (public.prep_has_role('instructor')) with check (public.prep_has_role('instructor'));
drop policy if exists "read" on public.prep_essay_versions;
create policy "read" on public.prep_essay_versions for select to authenticated using (public.prep_has_role('instructor'));
grant select, insert, update, delete on public.prep_essay_questions to authenticated;
grant select, update on public.prep_essays to authenticated;
grant select on public.prep_essay_versions to authenticated;
drop trigger if exists prep_essay_questions_audit on public.prep_essay_questions;
create trigger prep_essay_questions_audit after insert or update or delete on public.prep_essay_questions
  for each row execute function public.prep_audit('target_rank');

-- Marking only changes the marking fields (what the student handed in stays as it was)
create or replace function public.prep_essay_mark_guard() returns trigger language plpgsql as $$
begin
  if current_setting('prep.essay_submit', true) = 'on' then return new; end if;   -- the student's own hand-in
  if (new.body, new.word_count, new.file_path, new.file_name, new.file_type, new.submitted_at, new.version, new.token, new.cycle_id, new.student_id, new.target_rank)
     is distinct from (old.body, old.word_count, old.file_path, old.file_name, old.file_type, old.submitted_at, old.version, old.token, old.cycle_id, old.student_id, old.target_rank) then
    raise exception 'Only the marking can be changed here.';
  end if;
  if new.status not in ('needs_changes', 'reviewed') and new.status is distinct from old.status then
    raise exception 'An essay can be marked reviewed or sent back for changes.';
  end if;
  if new.status is distinct from old.status and old.status = 'not_submitted' then
    raise exception 'Nothing has been handed in yet.';
  end if;
  new.reviewed_by := public.prep_email(); new.reviewed_at := now();
  return new;
end $$;
drop trigger if exists prep_essay_mark_guard on public.prep_essays;
create trigger prep_essay_mark_guard before update on public.prep_essays for each row execute function public.prep_essay_mark_guard();

-- Personal links: makes the essay record (and its secret) for students going for a Dan.
-- p_new: a new secret, so the old link stops working.
create or replace function public.prep_essay_links(p_cycle uuid, p_student text default null, p_new boolean default false)
returns table (student_id text, target_rank text, token text, status text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r record; t text;
begin
  if not public.prep_has_role('instructor') then raise exception 'Your login cannot see essays.' using errcode = '42501'; end if;
  for r in
    select e.student_id, public.prep_next_belt(s.belt_rank) as target
      from public.prep_enrolments e join public.prep_students s using (student_id)
     where e.cycle_id = p_cycle and (p_student is null or e.student_id = p_student)
       and public.prep_next_belt(s.belt_rank) in ('1st Dan Black Belt', '2nd Dan', '3rd Dan', '4th Dan', '5th Dan', '6th Dan', '7th Dan', '8th Dan', '9th Dan')
  loop
    t := translate(left(encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), 12), '+/', '-_');  -- 12 url-safe chars
    insert into public.prep_essays (cycle_id, student_id, target_rank, token) values (p_cycle, r.student_id, r.target, t)
      on conflict (cycle_id, student_id) do nothing;
    if p_new and p_student is not null then
      perform set_config('prep.essay_submit', 'on', true);
      update public.prep_essays pe set token = t where pe.cycle_id = p_cycle and pe.student_id = r.student_id;
      perform set_config('prep.essay_submit', 'off', true);
    end if;
  end loop;
  return query select pe.student_id, pe.target_rank, pe.token, pe.status from public.prep_essays pe
    where pe.cycle_id = p_cycle and (p_student is null or pe.student_id = p_student) order by pe.student_id;
end $$;
revoke all on function public.prep_essay_links(uuid, text, boolean) from public, anon;
grant execute on function public.prep_essay_links(uuid, text, boolean) to authenticated;

-- ---------- The student's link (no login) ----------
create or replace function public.prep_essay_get(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('first_name', split_part(s.full_name, ' ', 1), 'target_rank', e.target_rank,
           'question', q.question, 'min_words', q.min_words, 'due', c.essay_due, 'cycle', c.name,
           'status', e.status, 'body', e.body, 'word_count', e.word_count, 'file_name', e.file_name,
           'submitted_at', e.submitted_at, 'version', e.version,
           'feedback', case when e.status in ('needs_changes', 'reviewed') then e.feedback end,
           'mark', case when e.status = 'reviewed' then e.mark end,
           'locked', e.status = 'reviewed' or c.status = 'archived')
    from public.prep_essays e
    join public.prep_students s on s.student_id = e.student_id
    join public.prep_cycles c on c.cycle_id = e.cycle_id
    left join public.prep_essay_questions q on q.target_rank = e.target_rank
   where e.token = p_token and length(coalesce(p_token, '')) >= 8
$$;
revoke all on function public.prep_essay_get(text) from public;
grant execute on function public.prep_essay_get(text) to anon, authenticated;

-- May this link upload a file? (used by the storage rule below)
create or replace function public.prep_essay_token_ok(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.prep_essays e join public.prep_cycles c using (cycle_id)
                  where e.token = p_token and length(coalesce(p_token, '')) >= 8 and e.status <> 'reviewed' and c.status <> 'archived')
$$;
revoke all on function public.prep_essay_token_ok(text) from public;
grant execute on function public.prep_essay_token_ok(text) to anon, authenticated;

-- Hand in (or hand in again): the text and/or a file uploaded to the essays storage first.
-- p_keep_file: keep the file already handed in (when only the text changes).
create or replace function public.prep_essay_submit(p_token text, p_body text, p_file_path text default null, p_file_name text default null, p_file_type text default null, p_keep_file boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.prep_essays%rowtype; words int; b text := nullif(trim(coalesce(p_body, '')), ''); fp text; fn text; ft text;
begin
  select * into e from public.prep_essays where token = p_token and length(coalesce(p_token, '')) >= 8;
  if not found then raise exception 'This link is not right. Ask your instructor for a new one.'; end if;
  if not public.prep_essay_token_ok(p_token) then raise exception 'This essay has been marked, so it can no longer be changed.'; end if;
  if b is not null and length(b) > 200000 then raise exception 'The essay is too long.'; end if;
  if p_file_path is not null and not starts_with(p_file_path, p_token || '/') then raise exception 'That file is not from this link.'; end if;
  fp := coalesce(p_file_path, case when p_keep_file then e.file_path end);
  fn := case when p_file_path is not null then left(p_file_name, 200) when p_keep_file then e.file_name end;
  ft := case when p_file_path is not null then left(p_file_type, 100) when p_keep_file then e.file_type end;
  if b is null and fp is null then raise exception 'Type or paste your essay, or choose a file.'; end if;
  words := coalesce(array_length(regexp_split_to_array(b, '\s+'), 1), 0);
  if e.version > 0 then   -- keep the version being replaced
    insert into public.prep_essay_versions (essay_id, version, body, word_count, file_path, file_name, file_type, submitted_at, feedback)
      values (e.essay_id, e.version, e.body, e.word_count, e.file_path, e.file_name, e.file_type, e.submitted_at, e.feedback)
      on conflict do nothing;
  end if;
  perform set_config('prep.essay_submit', 'on', true);
  update public.prep_essays set body = b, word_count = words, file_path = fp, file_name = fn, file_type = ft,
         submitted_at = now(), version = e.version + 1, status = 'submitted'
   where essay_id = e.essay_id;
  perform set_config('prep.essay_submit', 'off', true);
  return jsonb_build_object('ok', true, 'word_count', words, 'version', e.version + 1);
end $$;
revoke all on function public.prep_essay_submit(text, text, text, text, text, boolean) from public;
grant execute on function public.prep_essay_submit(text, text, text, text, text, boolean) to anon, authenticated;

-- ---------- Files: a private storage bucket ----------
-- A link can upload into its own folder (named after its secret); only admins and instructors can open files.
insert into storage.buckets (id, name, public) values ('prep-essays', 'prep-essays', false) on conflict (id) do update set public = false;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    execute $q$update storage.buckets set file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']
      where id = 'prep-essays'$q$;
  end if;
end $$;
drop policy if exists "prep essays upload" on storage.objects;
drop policy if exists "prep essays read" on storage.objects;
create policy "prep essays upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'prep-essays' and public.prep_essay_token_ok((storage.foldername(name))[1]));
create policy "prep essays read" on storage.objects for select to authenticated
  using (bucket_id = 'prep-essays' and public.prep_has_role('instructor'));
