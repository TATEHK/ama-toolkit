-- Black Belt Prep: update 17 (essays close on the due date)
-- Run once in Supabase > SQL Editor, after prep-update-16.sql. Safe to run again.
-- Once a cycle's essay due date has passed, students can no longer change or hand in their essay
-- (enforced on the server: the submit function, the upload rule, and the student's link all honour it).
-- "Today" is Sydney time, and the due date itself is still open (they have until the end of that day's cycle run;
-- the cutoff is the day after the due date).

-- The student's link: now also reports 'overdue', and locks once the due date has passed
create or replace function public.prep_essay_get(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('first_name', split_part(s.full_name, ' ', 1), 'target_rank', e.target_rank,
           'question', q.question, 'min_words', q.min_words, 'due', c.essay_due, 'cycle', c.name,
           'status', e.status, 'body', e.body, 'word_count', e.word_count, 'file_name', e.file_name,
           'submitted_at', e.submitted_at, 'version', e.version,
           'feedback', case when e.status in ('needs_changes', 'reviewed') then e.feedback end,
           'mark', case when e.status = 'reviewed' then e.mark end,
           'overdue', (c.essay_due is not null and (now() at time zone 'Australia/Sydney')::date > c.essay_due and e.status <> 'reviewed'),
           'locked', e.status = 'reviewed' or c.status = 'archived'
                     or (c.essay_due is not null and (now() at time zone 'Australia/Sydney')::date > c.essay_due))
    from public.prep_essays e
    join public.prep_students s on s.student_id = e.student_id
    join public.prep_cycles c on c.cycle_id = e.cycle_id
    left join public.prep_essay_questions q on q.target_rank = e.target_rank
   where e.token = p_token and length(coalesce(p_token, '')) >= 8
$$;

-- May this link still upload a file? Not once the due date has passed.
create or replace function public.prep_essay_token_ok(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.prep_essays e join public.prep_cycles c using (cycle_id)
                  where e.token = p_token and length(coalesce(p_token, '')) >= 8 and e.status <> 'reviewed' and c.status <> 'archived'
                    and (c.essay_due is null or (now() at time zone 'Australia/Sydney')::date <= c.essay_due))
$$;

-- Hand in (or hand in again): refused once the due date has passed.
create or replace function public.prep_essay_submit(p_token text, p_body text, p_file_path text default null, p_file_name text default null, p_file_type text default null, p_keep_file boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.prep_essays%rowtype; words int; b text := nullif(trim(coalesce(p_body, '')), ''); fp text; fn text; ft text;
begin
  select * into e from public.prep_essays where token = p_token and length(coalesce(p_token, '')) >= 8;
  if not found then raise exception 'This link is not right. Ask your instructor for a new one.'; end if;
  if exists (select 1 from public.prep_cycles c where c.cycle_id = e.cycle_id and c.essay_due is not null and (now() at time zone 'Australia/Sydney')::date > c.essay_due) then
    raise exception 'The due date for essays has passed, so it can no longer be changed.';
  end if;
  if not public.prep_essay_token_ok(p_token) then raise exception 'This essay has been marked, so it can no longer be changed.'; end if;
  if b is not null and length(b) > 200000 then raise exception 'The essay is too long.'; end if;
  if p_file_path is not null and not starts_with(p_file_path, p_token || '/') then raise exception 'That file is not from this link.'; end if;
  fp := coalesce(p_file_path, case when p_keep_file then e.file_path end);
  fn := case when p_file_path is not null then left(p_file_name, 200) when p_keep_file then e.file_name end;
  ft := case when p_file_path is not null then left(p_file_type, 100) when p_keep_file then e.file_type end;
  if b is null and fp is null then raise exception 'Type or paste your essay, or choose a file.'; end if;
  words := coalesce(array_length(regexp_split_to_array(b, '\s+'), 1), 0);
  if e.version > 0 then
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
