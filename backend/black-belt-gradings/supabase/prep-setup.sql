-- Black Belt Prep System: database setup
-- Runs in the same Supabase project as AMA ID Cards, after that project's setup.sql, roles.sql and printed.sql.
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run. Safe to run more than once.
--
-- Everything here is new and prefixed "prep_". The only change to the card software is one extra,
-- optional column on its people table (student_id). Its existing data, designs and print history are not touched.

-- ============================================================================
-- Roles
-- ============================================================================
--   admin        everything, including students, cycles, settings, users and the audit log
--   instructor   readiness, attendance
--   attendance   attendance only
--   payments     fees and payment records (nobody else can see money)
--   grading      grading records and results
--   certificates certificate records
--   idcards      ID card tracking and sending passed students to the card software
--   viewer       can look (no payment details) but not change anything
-- A person can hold several roles. No row means no access.

create table if not exists public.prep_roles (
  email      text not null,
  role       text not null check (role in ('admin','instructor','attendance','payments','grading','certificates','idcards','viewer')),
  created_at timestamptz not null default now(),
  primary key (email, role)
);

create or replace function public.prep_email() returns text
  language sql stable as $$ select lower(auth.jwt() ->> 'email') $$;

create or replace function public.prep_has_role(variadic roles text[]) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from public.prep_roles where email = public.prep_email() and (role = any(roles) or role = 'admin')) $$;

create or replace function public.prep_my_roles() returns text[]
  language sql stable security definer set search_path = public
  as $$ select coalesce(array_agg(role order by role), '{}') from public.prep_roles where email = public.prep_email() $$;

create or replace function public.prep_can_view() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from public.prep_roles where email = public.prep_email()) $$;

grant execute on function public.prep_email(), public.prep_my_roles(), public.prep_can_view() to authenticated;
grant execute on function public.prep_has_role(text[]) to authenticated;

-- Card software admins start as prep admins (first run only; change roles in the app afterwards)
insert into public.prep_roles (email, role)
  select lower(email), 'admin' from public.staff_roles where role = 'admin'
  on conflict do nothing;

-- Never leave the prep system without an admin
create or replace function public.prep_keep_an_admin() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and not exists (
    select 1 from public.prep_roles where role = 'admin' and email <> old.email) then
    raise exception 'There must always be at least one admin.';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists prep_roles_keep_admin on public.prep_roles;
create trigger prep_roles_keep_admin before update or delete on public.prep_roles
  for each row execute function public.prep_keep_an_admin();

-- ============================================================================
-- Settings (one row)
-- ============================================================================
create table if not exists public.prep_settings (
  id                         int primary key default 1 check (id = 1),
  sessions_required          int not null default 4 check (sessions_required between 0 and 20),
  excused_counts_as_attended boolean not null default false,
  allow_multiple_active      boolean not null default false,
  default_session_fee        numeric(10,2) not null default 0 check (default_session_fee >= 0),
  invoice_on_enrol           boolean not null default true,
  updated_at                 timestamptz not null default now()
);
insert into public.prep_settings (id) values (1) on conflict (id) do nothing;

-- ============================================================================
-- Students (the master register)
-- ============================================================================
create sequence if not exists public.prep_student_seq;

create table if not exists public.prep_students (
  student_id       text primary key default ('BB' || lpad(nextval('public.prep_student_seq')::text, 4, '0'))
                   check (student_id ~ '^[A-Za-z0-9-]{2,20}$'),
  full_name        text not null check (length(trim(full_name)) > 0),
  certificate_name text,
  dob              date,
  club             text,
  belt_rank        text,
  contact_email    text,
  contact_phone    text,
  is_active        boolean not null default true,
  is_test          boolean not null default false,
  date_added       date not null default current_date,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- Student IDs are permanent
create or replace function public.prep_student_id_fixed() returns trigger language plpgsql as $$
begin
  if new.student_id is distinct from old.student_id then raise exception 'A Student ID cannot be changed.'; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists prep_students_id_fixed on public.prep_students;
create trigger prep_students_id_fixed before update on public.prep_students
  for each row execute function public.prep_student_id_fixed();

-- ============================================================================
-- Preparation cycles and sessions
-- ============================================================================
create table if not exists public.prep_cycles (
  cycle_id         uuid primary key default gen_random_uuid(),
  name             text not null unique check (length(trim(name)) > 0),
  start_date       date,
  end_date         date,
  session_fee      numeric(10,2) not null default 0 check (session_fee >= 0),
  payment_due_date date,
  status           text not null default 'planned' check (status in ('planned','active','completed','archived')),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table if not exists public.prep_sessions (
  session_id     uuid primary key default gen_random_uuid(),
  cycle_id       uuid not null references public.prep_cycles on delete cascade,
  session_number int  not null check (session_number between 1 and 20),
  session_date   date,
  unique (cycle_id, session_number),
  unique (session_id, cycle_id)
);

-- Who is taking part in each cycle
create table if not exists public.prep_enrolments (
  cycle_id    uuid not null references public.prep_cycles on delete cascade,
  student_id  text not null references public.prep_students on update restrict on delete restrict,
  enrolled_at timestamptz not null default now(),
  primary key (cycle_id, student_id)
);

-- ============================================================================
-- Attendance
-- ============================================================================
create table if not exists public.prep_attendance (
  attendance_id uuid primary key default gen_random_uuid(),
  student_id    text not null,
  cycle_id      uuid not null,
  session_id    uuid not null,
  status        text not null default 'not_recorded' check (status in ('present','absent','excused','not_recorded')),
  recorded_at   timestamptz,
  recorded_by   text,
  notes         text,
  unique (student_id, session_id),
  foreign key (session_id, cycle_id) references public.prep_sessions (session_id, cycle_id) on delete cascade,
  foreign key (cycle_id, student_id) references public.prep_enrolments (cycle_id, student_id) on delete cascade
);
create index if not exists prep_attendance_cycle_idx on public.prep_attendance (cycle_id, student_id);

create or replace function public.prep_attendance_stamp() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.status = 'not_recorded' then
    new.recorded_at := null; new.recorded_by := null;
  elsif tg_op = 'INSERT' or new.status is distinct from old.status or new.notes is distinct from old.notes then
    new.recorded_at := now();
    new.recorded_by := coalesce(public.prep_email(), new.recorded_by);
  end if;
  return new;
end $$;
drop trigger if exists prep_attendance_stamp on public.prep_attendance;
create trigger prep_attendance_stamp before insert or update on public.prep_attendance
  for each row execute function public.prep_attendance_stamp();

-- ============================================================================
-- Readiness (one current record per student per cycle, every change kept in history)
-- ============================================================================
create table if not exists public.prep_readiness (
  readiness_id uuid primary key default gen_random_uuid(),
  student_id   text not null,
  cycle_id     uuid not null,
  status       text not null default 'not_assessed'
               check (status in ('not_assessed','on_track','needs_preparation','not_ready','ready','awaiting_review')),
  reason       text check (reason in ('technique','fitness','attendance','more_practice','instructor_recommendation','other')),
  notes        text,
  next_action  text,
  reviewed_at  timestamptz,
  reviewed_by  text,
  unique (student_id, cycle_id),
  foreign key (cycle_id, student_id) references public.prep_enrolments (cycle_id, student_id) on delete cascade
);

create table if not exists public.prep_readiness_history (
  history_id   bigint generated always as identity primary key,
  readiness_id uuid not null,
  student_id   text not null,
  cycle_id     uuid not null,
  status       text not null,
  reason       text,
  notes        text,
  next_action  text,
  changed_at   timestamptz not null default now(),
  changed_by   text
);

create or replace function public.prep_readiness_stamp() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.status, new.reason, new.notes, new.next_action)
       is not distinct from (old.status, old.reason, old.notes, old.next_action) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.reviewed_at := now();
    new.reviewed_by := public.prep_email();
  end if;
  return new;
end $$;
drop trigger if exists prep_readiness_stamp on public.prep_readiness;
create trigger prep_readiness_stamp before update on public.prep_readiness
  for each row execute function public.prep_readiness_stamp();

create or replace function public.prep_readiness_log() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.status, new.reason, new.notes, new.next_action)
       is not distinct from (old.status, old.reason, old.notes, old.next_action) then
    return new;
  end if;
  insert into public.prep_readiness_history (readiness_id, student_id, cycle_id, status, reason, notes, next_action, changed_by)
  values (new.readiness_id, new.student_id, new.cycle_id, new.status, new.reason, new.notes, new.next_action, public.prep_email());
  return new;
end $$;
drop trigger if exists prep_readiness_log on public.prep_readiness;
create trigger prep_readiness_log after insert or update on public.prep_readiness
  for each row execute function public.prep_readiness_log();

-- ============================================================================
-- Payments (one record per student per cycle) and every transaction kept separately
-- ============================================================================
create table if not exists public.prep_payments (
  payment_id      uuid primary key default gen_random_uuid(),
  student_id      text not null,
  cycle_id        uuid not null,
  amount_due      numeric(10,2) not null default 0 check (amount_due >= 0),
  invoiced_at     timestamptz,
  due_date        date,
  status_override text check (status_override in
                  ('not_invoiced','due','partially_paid','paid','overdue','waived','refund_pending','refunded')),
  override_reason text,
  notes           text,
  updated_at      timestamptz not null default now(),
  unique (student_id, cycle_id),
  -- Removing an enrolment removes its fee record, unless a transaction exists (then it is blocked)
  foreign key (cycle_id, student_id) references public.prep_enrolments (cycle_id, student_id) on delete cascade,
  check (status_override is null or length(trim(coalesce(override_reason, ''))) > 0)
);

create table if not exists public.prep_payment_transactions (
  transaction_id uuid primary key default gen_random_uuid(),
  payment_id     uuid not null references public.prep_payments on delete restrict,
  student_id     text not null,
  cycle_id       uuid not null,
  type           text not null check (type in ('payment','refund','correction')),
  amount         numeric(10,2) not null,
  paid_on        date not null default current_date,
  method         text check (method in ('cash','bank_transfer','card_in_person','online','other')),
  reference      text,
  notes          text,
  recorded_by    text default lower(auth.jwt() ->> 'email'),
  created_at     timestamptz not null default now(),
  check ((type in ('payment','refund') and amount > 0) or (type = 'correction' and amount <> 0)),
  check (type <> 'correction' or length(trim(coalesce(notes, ''))) > 0)
);
-- The same receipt number cannot be entered twice for one student's cycle fee
create unique index if not exists prep_tx_reference_once
  on public.prep_payment_transactions (payment_id, lower(trim(reference)))
  where reference is not null and trim(reference) <> '';

-- Transactions are never edited or deleted. Mistakes are fixed with a "correction" transaction.
create or replace function public.prep_tx_locked() returns trigger language plpgsql as $$
begin
  raise exception 'Payment transactions cannot be changed or deleted. Record a correction instead.';
end $$;
drop trigger if exists prep_tx_locked on public.prep_payment_transactions;
create trigger prep_tx_locked before update or delete on public.prep_payment_transactions
  for each row execute function public.prep_tx_locked();

-- Keep student and cycle on a transaction consistent with its payment record
create or replace function public.prep_tx_fill() returns trigger language plpgsql as $$
declare p public.prep_payments%rowtype;
begin
  select * into p from public.prep_payments where payment_id = new.payment_id;
  new.student_id := p.student_id;
  new.cycle_id := p.cycle_id;
  new.recorded_by := coalesce(public.prep_email(), new.recorded_by);
  return new;
end $$;
drop trigger if exists prep_tx_fill on public.prep_payment_transactions;
create trigger prep_tx_fill before insert on public.prep_payment_transactions
  for each row execute function public.prep_tx_fill();

-- ============================================================================
-- Grading
-- ============================================================================
create table if not exists public.prep_grading (
  grading_id           uuid primary key default gen_random_uuid(),
  student_id           text not null references public.prep_students on delete restrict,
  cycle_id             uuid references public.prep_cycles on delete restrict,
  grading_event        text not null,
  grading_date         date,
  current_rank         text,
  target_rank          text,
  attendance_eligible  boolean,
  readiness_at_review  text,
  eligibility_decision text not null default 'pending' check (eligibility_decision in ('pending','eligible','not_eligible')),
  decision_reason      text,
  decided_by           text,
  decided_at           timestamptz,
  status               text not null default 'not_assessed' check (status in
                       ('not_assessed','awaiting_review','eligible','not_eligible','nominated','booked','completed','passed','unsuccessful','deferred')),
  result               text check (result in ('passed','unsuccessful','deferred')),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (student_id, grading_event)
);

-- When an eligibility decision is made, snapshot the facts it was based on
create or replace function public.prep_grading_stamp() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' or new.eligibility_decision is distinct from old.eligibility_decision then
    if new.eligibility_decision <> 'pending' then
      new.decided_by := public.prep_email();
      new.decided_at := now();
      if new.cycle_id is not null then
        select s.attendance_eligible into new.attendance_eligible
          from public.prep_attendance_summary s where s.student_id = new.student_id and s.cycle_id = new.cycle_id;
        select r.status into new.readiness_at_review
          from public.prep_readiness r where r.student_id = new.student_id and r.cycle_id = new.cycle_id;
      end if;
    end if;
  end if;
  -- A decision that goes against the attendance requirement or readiness needs a reason
  if new.eligibility_decision = 'eligible'
     and (new.attendance_eligible is false or coalesce(new.readiness_at_review, 'ready') <> 'ready')
     and length(trim(coalesce(new.decision_reason, ''))) = 0 then
    raise exception 'Give a reason when marking someone eligible who has not met attendance or is not marked ready.';
  end if;
  if new.result is not null and new.status not in ('passed','unsuccessful','deferred') then
    new.status := new.result;
  end if;
  return new;
end $$;

-- ============================================================================
-- Certificates
-- ============================================================================
create table if not exists public.prep_certificates (
  certificate_id     uuid primary key default gen_random_uuid(),
  student_id         text not null references public.prep_students on delete restrict,
  grading_id         uuid references public.prep_grading on delete restrict,
  certificate_name   text not null,
  certificate_type   text not null default 'Dan certificate',
  awarded_rank       text,
  certificate_number text unique,
  issue_date         date,
  status             text not null default 'awaiting_result' check (status in
                     ('not_required','awaiting_result','awaiting_approval','details_check','approved','ready_for_production','printed','issued','reprint_required')),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- A certificate can only move past approval once its grading result is a pass
create or replace function public.prep_certificate_check() returns trigger language plpgsql as $$
declare res text;
begin
  new.updated_at := now();
  if new.status in ('approved','ready_for_production','printed','issued') then
    select result into res from public.prep_grading where grading_id = new.grading_id;
    if res is distinct from 'passed' then
      raise exception 'A certificate can only be approved, produced or issued for a passed grading.';
    end if;
  end if;
  if new.status = 'issued' and new.issue_date is null then new.issue_date := current_date; end if;
  return new;
end $$;
drop trigger if exists prep_certificate_check on public.prep_certificates;
create trigger prep_certificate_check before insert or update on public.prep_certificates
  for each row execute function public.prep_certificate_check();

-- ============================================================================
-- ID cards (the card software keeps the card details and print history; this adds the rest)
-- ============================================================================
alter table public.people add column if not exists student_id text;
create unique index if not exists people_student_id_once on public.people (student_id) where student_id is not null;

create table if not exists public.prep_id_cards (
  student_id         text primary key references public.prep_students on delete restrict,
  card_type          text not null default 'Dan certificate ID card',
  required           boolean not null default true,
  requested_at       date not null default current_date,
  ready_to_collect_at timestamptz,
  collected_at       timestamptz,
  reprint_reason     text,
  notes              text,
  updated_at         timestamptz not null default now()
);

create table if not exists public.prep_print_event_notes (
  print_job_id   uuid not null,
  student_id     text not null references public.prep_students on delete restrict,
  reprint_reason text,
  notes          text,
  primary key (print_job_id, student_id)
);

-- What the prep system may see of the card software, for anyone with a prep role.
-- Read through these functions so prep users do not also need a card software role.
create or replace function public.prep_card_people()
returns table (person_id uuid, student_id text, name text, dob date, dan text, issued date,
               has_photo boolean, printed_at timestamptz, queue_status text, times_printed int)
  language sql stable security definer set search_path = public as $$
  select p.id, p.student_id, p.name, p.dob, p.dan, p.issued,
         p.photo_path is not null, p.printed_at,
         (select j.status from public.print_jobs j
           where p.id = any(j.people_ids) and j.status in ('pending','approved','printing')
           order by j.created_at desc limit 1),
         (select count(*)::int from public.print_jobs j where p.id = any(j.people_ids) and j.status = 'printed')
  from public.people p
  where public.prep_can_view()
$$;

create or replace function public.prep_card_print_history()
returns table (print_job_id uuid, person_id uuid, student_id text, name text, status text,
               created_at timestamptz, approved_by text, printed_at timestamptz, print_number int, error text)
  language sql stable security definer set search_path = public as $$
  select j.id, p.id, p.student_id, p.name, j.status, j.created_at, j.approved_by_email, j.printed_at,
         (row_number() over (partition by p.id, (j.status = 'printed') order by j.created_at))::int,
         j.error
  from public.print_jobs j
  join public.people p on p.id = any(j.people_ids)
  where public.prep_can_view()
$$;
grant execute on function public.prep_card_people(), public.prep_card_print_history() to authenticated;

-- ============================================================================
-- Report templates and audit log
-- ============================================================================
create table if not exists public.prep_report_templates (
  template_id uuid primary key default gen_random_uuid(),
  name        text not null,
  report_type text not null,
  audience    text not null default 'admin' check (audience in ('instructor','admin')),
  columns     jsonb not null default '[]',
  filters     jsonb not null default '{}',
  created_by  text default lower(auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  unique (report_type, name)
);

create table if not exists public.prep_audit_log (
  log_id     bigint generated always as identity primary key,
  table_name text not null,
  record_key text,
  action     text not null,
  old_row    jsonb,
  new_row    jsonb,
  changed_by text,
  changed_at timestamptz not null default now()
);

create or replace function public.prep_audit() returns trigger
  language plpgsql security definer set search_path = public as $$
declare k text;
begin
  k := coalesce(to_jsonb(coalesce(new, old)) ->> tg_argv[0], '');
  insert into public.prep_audit_log (table_name, record_key, action, old_row, new_row, changed_by)
  values (tg_table_name, k, lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          public.prep_email());
  return coalesce(new, old);
end $$;

do $$
declare t record;
begin
  for t in select * from (values
    ('prep_roles','email'), ('prep_settings','id'), ('prep_students','student_id'), ('prep_cycles','cycle_id'),
    ('prep_sessions','session_id'), ('prep_enrolments','student_id'), ('prep_attendance','attendance_id'),
    ('prep_payments','payment_id'), ('prep_payment_transactions','transaction_id'), ('prep_grading','grading_id'),
    ('prep_certificates','certificate_id'), ('prep_id_cards','student_id')) as v(tbl, keycol)
  loop
    execute format('drop trigger if exists %I on public.%I', t.tbl || '_audit', t.tbl);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.prep_audit(%L)',
                   t.tbl || '_audit', t.tbl, t.keycol);
  end loop;
end $$;

-- ============================================================================
-- Calculations (views run with the caller's permissions, so hidden rows stay hidden)
-- ============================================================================

-- Attendance percentage = present / (present + absent). Excused and not-yet-recorded sessions are left out.
-- Attendance requirement = present (plus excused, if that setting is on) >= sessions required.
create or replace view public.prep_attendance_summary with (security_invoker = true) as
select e.cycle_id, e.student_id,
       count(*) filter (where a.status = 'present')      ::int as attended,
       count(*) filter (where a.status = 'absent')       ::int as absences,
       count(*) filter (where a.status = 'excused')      ::int as excused,
       count(*) filter (where a.status = 'not_recorded') ::int as unrecorded,
       count(a.attendance_id)                             ::int as sessions,
       case when count(*) filter (where a.status in ('present','absent')) = 0 then null
            else round(100.0 * count(*) filter (where a.status = 'present')
                       / count(*) filter (where a.status in ('present','absent')), 1) end as attendance_pct,
       (count(*) filter (where a.status = 'present')
        + case when s.excused_counts_as_attended then count(*) filter (where a.status = 'excused') else 0 end)
         >= s.sessions_required as attendance_eligible
from public.prep_enrolments e
cross join public.prep_settings s
left join public.prep_attendance a on a.cycle_id = e.cycle_id and a.student_id = e.student_id
group by e.cycle_id, e.student_id, s.excused_counts_as_attended, s.sessions_required;

-- Total paid, balance and payment status for each student's cycle fee
create or replace view public.prep_payment_summary with (security_invoker = true) as
with t as (
  select payment_id,
         coalesce(sum(case type when 'refund' then -amount else amount end), 0) as paid,
         coalesce(sum(amount) filter (where type = 'refund'), 0) as refunded,
         count(*)::int as transactions,
         max(paid_on) as last_paid_on
  from public.prep_payment_transactions group by payment_id
)
select p.payment_id, p.student_id, p.cycle_id, p.amount_due,
       coalesce(t.paid, 0) as amount_paid,
       p.amount_due - coalesce(t.paid, 0) as balance,
       coalesce(t.transactions, 0) as transactions,
       t.last_paid_on,
       coalesce(p.due_date, c.payment_due_date) as due_date,
       coalesce(p.status_override,
         case
           when coalesce(t.refunded, 0) > 0 and coalesce(t.paid, 0) <= 0 then 'refunded'
           when p.amount_due > 0 and coalesce(t.paid, 0) >= p.amount_due then 'paid'
           when p.amount_due = 0 and p.invoiced_at is not null then 'paid'
           when p.invoiced_at is null then 'not_invoiced'
           when coalesce(p.due_date, c.payment_due_date) < current_date then 'overdue'
           when coalesce(t.paid, 0) > 0 then 'partially_paid'
           else 'due'
         end) as status,
       p.status_override is not null as status_overridden,
       p.override_reason, p.notes
from public.prep_payments p
join public.prep_cycles c on c.cycle_id = p.cycle_id
left join t on t.payment_id = p.payment_id;

-- Current ID card status for each student who has a card record
create or replace view public.prep_id_card_status with (security_invoker = true) as
select ic.student_id, ic.card_type, cp.person_id, cp.has_photo, cp.printed_at, cp.queue_status,
       cp.times_printed, ic.ready_to_collect_at, ic.collected_at, ic.reprint_reason,
       case
         when not ic.required then 'not_required'
         when cp.person_id is null then 'required'
         when cp.queue_status is not null then 'sent_for_printing'
         when cp.printed_at is null and cp.times_printed > 0 then 'reprint_required'
         when cp.printed_at is null and (not cp.has_photo or cp.dob is null or coalesce(cp.dan, '') = '') then 'details_incomplete'
         when cp.printed_at is null then 'ready_for_printing'
         when ic.collected_at >= cp.printed_at then 'collected'
         when ic.ready_to_collect_at >= cp.printed_at then 'awaiting_collection'
         else 'printed'
       end as status
from public.prep_id_cards ic
left join public.prep_card_people() cp on cp.student_id = ic.student_id;

-- Everything about a student's cycle in one row: the dashboard, register and follow-up list read this
create or replace view public.prep_overview with (security_invoker = true) as
select e.cycle_id, c.name as cycle_name, c.status as cycle_status,
       st.student_id, st.full_name, st.club, st.belt_rank, st.is_active, st.is_test,
       a.attended, a.absences, a.excused, a.unrecorded, a.sessions, a.attendance_pct, a.attendance_eligible,
       r.status as readiness, r.reason as readiness_reason, r.next_action, r.reviewed_at,
       ps.status as payment_status, ps.amount_due, ps.amount_paid, ps.balance,
       g.grading_id, g.status as grading_status, g.eligibility_decision, g.result as grading_result,
       cert.status as certificate_status,
       idc.status as id_card_status
from public.prep_enrolments e
join public.prep_cycles c on c.cycle_id = e.cycle_id
join public.prep_students st on st.student_id = e.student_id
left join public.prep_attendance_summary a on a.cycle_id = e.cycle_id and a.student_id = e.student_id
left join public.prep_readiness r on r.cycle_id = e.cycle_id and r.student_id = e.student_id
left join public.prep_payment_summary ps on ps.cycle_id = e.cycle_id and ps.student_id = e.student_id
left join lateral (select * from public.prep_grading g where g.cycle_id = e.cycle_id and g.student_id = e.student_id
                   order by g.created_at desc limit 1) g on true
left join lateral (select * from public.prep_certificates x where x.grading_id = g.grading_id
                   order by x.created_at desc limit 1) cert on true
left join public.prep_id_card_status idc on idc.student_id = e.student_id;

-- Possible duplicate students: same name ignoring case, spaces and punctuation, or same name and date of birth
create or replace view public.prep_possible_duplicates with (security_invoker = true) as
select a.student_id as student_a, b.student_id as student_b, a.full_name as name_a, b.full_name as name_b,
       a.dob = b.dob as same_dob
from public.prep_students a
join public.prep_students b on a.student_id < b.student_id
 and regexp_replace(lower(a.full_name), '[^a-z]', '', 'g') = regexp_replace(lower(b.full_name), '[^a-z]', '', 'g');

-- Now the views exist, the grading trigger can use them
drop trigger if exists prep_grading_stamp on public.prep_grading;
create trigger prep_grading_stamp before insert or update on public.prep_grading
  for each row execute function public.prep_grading_stamp();

-- ============================================================================
-- Automatic record creation (never touches earlier cycles)
-- ============================================================================

-- Enrolling a student creates their attendance rows, readiness record and payment record for that cycle only
create or replace function public.prep_on_enrol() returns trigger
  language plpgsql security definer set search_path = public as $$
declare c public.prep_cycles%rowtype; s public.prep_settings%rowtype;
begin
  select * into c from public.prep_cycles where cycle_id = new.cycle_id;
  select * into s from public.prep_settings where id = 1;
  insert into public.prep_attendance (student_id, cycle_id, session_id)
    select new.student_id, new.cycle_id, x.session_id from public.prep_sessions x where x.cycle_id = new.cycle_id
    on conflict do nothing;
  insert into public.prep_readiness (student_id, cycle_id) values (new.student_id, new.cycle_id) on conflict do nothing;
  insert into public.prep_payments (student_id, cycle_id, amount_due, invoiced_at)
    values (new.student_id, new.cycle_id, c.session_fee, case when s.invoice_on_enrol then now() end)
    on conflict do nothing;
  return new;
end $$;
drop trigger if exists prep_on_enrol on public.prep_enrolments;
create trigger prep_on_enrol after insert on public.prep_enrolments
  for each row execute function public.prep_on_enrol();

-- Adding a session to a cycle creates a "not recorded" row for everyone enrolled
create or replace function public.prep_on_session() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.prep_attendance (student_id, cycle_id, session_id)
    select e.student_id, new.cycle_id, new.session_id from public.prep_enrolments e where e.cycle_id = new.cycle_id
    on conflict do nothing;
  return new;
end $$;
drop trigger if exists prep_on_session on public.prep_sessions;
create trigger prep_on_session after insert on public.prep_sessions
  for each row execute function public.prep_on_session();

-- Changing a cycle's fee updates fees still at the old amount (individually changed fees are left alone)
create or replace function public.prep_on_cycle_change() returns trigger
  language plpgsql security definer set search_path = public as $$
declare others int; multi boolean;
begin
  new.updated_at := now();
  if new.status = 'active' and old.status is distinct from 'active' then
    select allow_multiple_active into multi from public.prep_settings where id = 1;
    select count(*) into others from public.prep_cycles where status = 'active' and cycle_id <> new.cycle_id;
    if others > 0 and not multi then
      raise exception 'Another cycle is already active. Complete it first, or allow several active cycles in Settings.';
    end if;
  end if;
  if new.session_fee is distinct from old.session_fee then
    update public.prep_payments set amount_due = new.session_fee, updated_at = now()
      where cycle_id = new.cycle_id and amount_due = old.session_fee;
  end if;
  return new;
end $$;
drop trigger if exists prep_on_cycle_change on public.prep_cycles;
create trigger prep_on_cycle_change before update on public.prep_cycles
  for each row execute function public.prep_on_cycle_change();

-- "Start New Preparation Cycle": creates the cycle (as Planned), its sessions and everyone's fresh records.
-- Running it twice with the same name stops with an error instead of creating duplicates.
-- p_student_ids: who to enrol. Leave empty to enrol every active, non-test student.
create or replace function public.prep_start_new_cycle(
  p_name text, p_start date, p_end date, p_session_dates date[], p_fee numeric,
  p_payment_due date default null, p_student_ids text[] default null, p_notes text default null)
returns uuid language plpgsql set search_path = public as $$
declare cid uuid; i int;
begin
  if not public.prep_has_role('admin') then raise exception 'Only an admin can start a new cycle.'; end if;
  if exists (select 1 from public.prep_cycles where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A cycle called "%" already exists.', p_name;
  end if;
  insert into public.prep_cycles (name, start_date, end_date, session_fee, payment_due_date, notes)
    values (trim(p_name), p_start, p_end, coalesce(p_fee, (select default_session_fee from public.prep_settings)), p_payment_due, p_notes)
    returning cycle_id into cid;
  for i in 1 .. greatest(coalesce(array_length(p_session_dates, 1), 0), 4) loop
    insert into public.prep_sessions (cycle_id, session_number, session_date) values (cid, i, p_session_dates[i]);
  end loop;
  insert into public.prep_enrolments (cycle_id, student_id)
    select cid, s.student_id from public.prep_students s
    where s.is_active and (case when coalesce(cardinality(p_student_ids), 0) = 0 then not s.is_test
                                else s.student_id = any(p_student_ids) end)
    order by s.full_name, s.student_id
    on conflict do nothing;
  return cid;
end $$;

-- Make a planned cycle the active one, optionally completing the current active cycle first
create or replace function public.prep_activate_cycle(p_cycle uuid, p_complete_current boolean default false)
returns void language plpgsql set search_path = public as $$
begin
  if not public.prep_has_role('admin') then raise exception 'Only an admin can activate a cycle.'; end if;
  if p_complete_current then
    update public.prep_cycles set status = 'completed' where status = 'active' and cycle_id <> p_cycle;
  end if;
  update public.prep_cycles set status = 'active' where cycle_id = p_cycle;
end $$;

-- Mark several students at once for one session. Only the students listed are changed;
-- nobody else is marked absent.
create or replace function public.prep_mark_attendance(p_session uuid, p_student_ids text[], p_status text, p_notes text default null)
returns int language plpgsql set search_path = public as $$
declare n int;
begin
  update public.prep_attendance set status = p_status, notes = coalesce(p_notes, notes)
    where session_id = p_session and student_id = any(p_student_ids) and status is distinct from p_status;
  get diagnostics n = row_count;
  return n;
end $$;

-- Add a passed student to the card software (or link them to an existing card person).
-- Existing card details are only changed when p_update_existing is true.
create or replace function public.prep_send_to_card_software(p_student text, p_dan text,
  p_person uuid default null, p_update_existing boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.prep_students%rowtype; pid uuid;
begin
  if not public.prep_has_role('idcards') then raise exception 'You do not have permission to manage ID cards.'; end if;
  select * into s from public.prep_students where student_id = p_student;
  if not found then raise exception 'Student % not found.', p_student; end if;
  select id into pid from public.people where student_id = p_student;
  if pid is null and p_person is not null then
    update public.people set student_id = p_student where id = p_person and student_id is null returning id into pid;
    if pid is null then raise exception 'That card record is already linked to another student.'; end if;
  end if;
  if pid is null then
    insert into public.people (name, dob, dan, student_id)
      values (coalesce(nullif(trim(s.certificate_name), ''), s.full_name), s.dob, p_dan, p_student)
      returning id into pid;
  elsif p_update_existing then
    update public.people set dan = coalesce(p_dan, dan), dob = coalesce(dob, s.dob), updated_at = now() where id = pid;
  end if;
  insert into public.prep_id_cards (student_id) values (p_student) on conflict (student_id) do nothing;
  return pid;
end $$;

grant execute on function public.prep_start_new_cycle(text, date, date, date[], numeric, date, text[], text),
  public.prep_activate_cycle(uuid, boolean), public.prep_mark_attendance(uuid, text[], text, text),
  public.prep_send_to_card_software(text, text, uuid, boolean) to authenticated;

-- ============================================================================
-- Security rules
-- ============================================================================
-- Row Level Security on every prep table (written out in full so Supabase's checker can see it)
alter table public.prep_roles                enable row level security;
alter table public.prep_settings             enable row level security;
alter table public.prep_students             enable row level security;
alter table public.prep_cycles               enable row level security;
alter table public.prep_sessions             enable row level security;
alter table public.prep_enrolments           enable row level security;
alter table public.prep_attendance           enable row level security;
alter table public.prep_readiness            enable row level security;
alter table public.prep_readiness_history    enable row level security;
alter table public.prep_payments             enable row level security;
alter table public.prep_payment_transactions enable row level security;
alter table public.prep_grading              enable row level security;
alter table public.prep_certificates         enable row level security;
alter table public.prep_id_cards             enable row level security;
alter table public.prep_print_event_notes    enable row level security;
alter table public.prep_report_templates     enable row level security;
alter table public.prep_audit_log            enable row level security;

do $$
declare t text;
begin
  foreach t in array array['prep_roles','prep_settings','prep_students','prep_cycles','prep_sessions','prep_enrolments',
    'prep_attendance','prep_readiness','prep_readiness_history','prep_payments','prep_payment_transactions','prep_grading',
    'prep_certificates','prep_id_cards','prep_print_event_notes','prep_report_templates','prep_audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "write" on public.%I', t);
    execute format('drop policy if exists "add" on public.%I', t);
    execute format('drop policy if exists "change" on public.%I', t);
    execute format('drop policy if exists "remove" on public.%I', t);
  end loop;
end $$;

-- Everyone with a prep role can read these
create policy "read" on public.prep_settings         for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_students         for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_cycles           for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_sessions         for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_enrolments       for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_attendance       for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_readiness        for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_readiness_history for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_grading          for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_certificates     for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_id_cards         for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_print_event_notes for select to authenticated using (public.prep_can_view());
create policy "read" on public.prep_report_templates for select to authenticated
  using (public.prep_can_view() and (audience = 'instructor' or public.prep_has_role('payments','grading','certificates','idcards')));

-- Money: payments role and admins only
create policy "read" on public.prep_payments             for select to authenticated using (public.prep_has_role('payments'));
create policy "read" on public.prep_payment_transactions for select to authenticated using (public.prep_has_role('payments'));
create policy "change" on public.prep_payments           for update to authenticated using (public.prep_has_role('payments')) with check (public.prep_has_role('payments'));
create policy "add" on public.prep_payment_transactions  for insert to authenticated with check (public.prep_has_role('payments'));

-- Roles, audit log: admins see; only admins manage roles
create policy "read"  on public.prep_roles     for select to authenticated using (email = public.prep_email() or public.prep_has_role('admin'));
create policy "write" on public.prep_roles     for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
create policy "read"  on public.prep_audit_log for select to authenticated using (public.prep_has_role('admin'));

-- Admin-managed records
create policy "write" on public.prep_settings   for update to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
create policy "write" on public.prep_students   for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
create policy "write" on public.prep_cycles     for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
create policy "write" on public.prep_sessions   for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
create policy "write" on public.prep_enrolments for all    to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
create policy "write" on public.prep_report_templates for all to authenticated
  using (public.prep_has_role('admin') or created_by = public.prep_email())
  with check (public.prep_can_view());

-- Attendance: instructors and attendance recorders (rows are created automatically; they only change them)
create policy "change" on public.prep_attendance for update to authenticated
  using (public.prep_has_role('instructor','attendance')) with check (public.prep_has_role('instructor','attendance'));

-- Readiness: instructors
create policy "change" on public.prep_readiness for update to authenticated
  using (public.prep_has_role('instructor')) with check (public.prep_has_role('instructor'));

-- Grading and certificates
create policy "write" on public.prep_grading      for all to authenticated using (public.prep_has_role('grading')) with check (public.prep_has_role('grading'));
create policy "write" on public.prep_certificates for all to authenticated using (public.prep_has_role('certificates')) with check (public.prep_has_role('certificates'));

-- ID cards
create policy "write" on public.prep_id_cards          for all to authenticated using (public.prep_has_role('idcards')) with check (public.prep_has_role('idcards'));
create policy "write" on public.prep_print_event_notes for all to authenticated using (public.prep_has_role('idcards')) with check (public.prep_has_role('idcards'));

-- ============================================================================
-- Live updates between devices
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['prep_students','prep_cycles','prep_sessions','prep_enrolments','prep_attendance',
    'prep_readiness','prep_payments','prep_payment_transactions','prep_grading','prep_certificates','prep_id_cards'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
