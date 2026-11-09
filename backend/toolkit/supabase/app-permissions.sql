-- AMA Toolkit: per-feature permissions for Coloured Belts, Black Belt Gradings and Long Service Awards (9 Nov 2026).
-- Each app has its own list of permissions (app_permissions), set on the Staff logins page. "admin" in an app means
-- everything in that app. The database enforces every permission (row security and the staff functions), so hiding a
-- button is never the only thing stopping someone.
--   Coloured Belts (cb):        view, days, belts, readiness, results, calls, payments,
--                               text_invite, text_result, text_followup, set_general, set_fees, set_wording, admin
--   Black Belt Gradings (bb):   view, attendance, readiness, essays, days, grading, results, scoring, calls, payments,
--                               text_invite, text_result, text_followup, certificates, idcards, polos, set_general, set_fees, set_wording, admin
--   Long Service Awards (awards): view, edit, admin
-- Legacy 'texts' and 'settings' (and the old bb 'grading' meaning) stay valid so existing rows keep working; a Staff
-- logins save replaces them with the split ticks. Texts split into invites/results/follow-ups; Settings into
-- structure/fees/wording (all three currently open the whole Settings screen). See migrations granular_perms_*.
-- Everyone's old Black Belt role (prep_roles) is turned into matching permissions in all three apps, so nobody loses access.
-- prep_roles is kept, filled in from the Black Belt permissions, for the few older things that still read it
-- (the TV, Clipboard, ID card lists and the follow-up texts function).
-- Safe to run more than once.

create table if not exists public.app_permissions (
  email text not null,
  app   text not null check (app in ('bb', 'cb', 'awards')),
  perm  text not null,
  added_at timestamptz not null default now(),
  primary key (email, app, perm),
  constraint app_permissions_perm check (
    (app = 'cb' and perm in ('view','days','belts','readiness','results','calls','payments',
      'text_invite','text_result','text_followup','set_general','set_fees','set_wording','admin','texts','settings')) or
    (app = 'bb' and perm in ('view','attendance','readiness','essays','days','grading','results','scoring','calls','payments',
      'text_invite','text_result','text_followup','certificates','idcards','polos','set_general','set_fees','set_wording','admin','texts','settings')) or
    (app = 'awards' and perm in ('view','edit','admin')))
);
alter table public.app_permissions enable row level security;
drop policy if exists "read own" on public.app_permissions;
create policy "read own" on public.app_permissions for select to authenticated using (email = lower(auth.jwt() ->> 'email'));
-- Only the "staff" function (service role) changes permissions.

-- Has the signed-in person any of these permissions in this app? ("admin" covers everything)
create or replace function public.app_can(p_app text, variadic p_perms text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_permissions where email = lower(auth.jwt() ->> 'email') and app = p_app and (perm = 'admin' or perm = any(p_perms)))
$$;
-- Any permission at all in this app (can open it)
create or replace function public.app_any(p_app text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_permissions where email = lower(auth.jwt() ->> 'email') and app = p_app)
$$;
-- My permissions in an app, for the pages
create or replace function public.app_my_perms(p_app text)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(perm order by perm), '{}') from public.app_permissions where email = lower(auth.jwt() ->> 'email') and app = p_app
$$;
revoke all on function public.app_can(text, text[]), public.app_any(text), public.app_my_perms(text) from public;
grant execute on function public.app_can(text, text[]), public.app_any(text), public.app_my_perms(text) to authenticated;

-- prep_roles, filled in from the Black Belt permissions (for older readers)
create or replace function public.app_sync_prep_roles(p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare want text[];
begin
  select coalesce(array_agg(distinct r), '{}') into want from (
    select case perm when 'admin' then 'admin' when 'attendance' then 'attendance' when 'readiness' then 'instructor' when 'texts' then 'grading'
                     when 'payments' then 'payments' when 'certificates' then 'certificates' when 'idcards' then 'idcards' end r
      from public.app_permissions where email = p_email and app = 'bb'
    union all
    select 'viewer' where exists (select 1 from public.app_permissions where email = p_email and app = 'bb')
                      and not exists (select 1 from public.app_permissions where email = p_email and app = 'bb' and perm = 'admin')) x
  where r is not null;
  insert into public.prep_roles (email, role) select p_email, r from unnest(want) r on conflict do nothing;
  delete from public.prep_roles where email = p_email and not (role = any(want));
end $$;
revoke all on function public.app_sync_prep_roles(text) from public;
create or replace function public.app_permissions_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.app, old.app) = 'bb' then perform public.app_sync_prep_roles(coalesce(new.email, old.email)); end if;
  return null;
end $$;
drop trigger if exists app_permissions_sync on public.app_permissions;

-- Everyone's old roles, as permissions in each app (only for people who have none yet, so running this again changes nothing)
insert into public.app_permissions (email, app, perm)
select r.email, m.app, m.perm from public.prep_roles r
join (values
  ('admin','bb','admin'), ('admin','cb','admin'), ('admin','awards','admin'),
  ('instructor','bb','view'), ('instructor','bb','attendance'), ('instructor','bb','readiness'), ('instructor','bb','scoring'),
  ('instructor','cb','view'), ('instructor','cb','readiness'), ('instructor','cb','calls'), ('instructor','awards','view'), ('instructor','awards','edit'),
  ('attendance','bb','view'), ('attendance','bb','attendance'),
  ('payments','bb','view'), ('payments','bb','payments'), ('payments','cb','view'), ('payments','cb','payments'), ('payments','awards','view'),
  ('grading','bb','view'), ('grading','bb','scoring'), ('grading','bb','grading'), ('grading','bb','texts'), ('grading','bb','polos'),
  ('grading','cb','view'), ('grading','cb','days'), ('grading','cb','readiness'), ('grading','cb','texts'), ('grading','cb','payments'), ('grading','cb','results'), ('grading','cb','calls'),
  ('grading','awards','view'), ('grading','awards','edit'),
  ('certificates','bb','view'), ('certificates','bb','certificates'),
  ('idcards','bb','view'), ('idcards','bb','idcards'),
  ('viewer','bb','view')
) m(role, app, perm) on m.role = r.role
where not exists (select 1 from public.app_permissions a where a.email = r.email)
on conflict do nothing;

create trigger app_permissions_sync after insert or update or delete on public.app_permissions for each row execute function public.app_permissions_sync();

-- Coloured belt entries: results and photos need "results"; a belt-only change needs "days" or "belts"; anything else needs "days".
-- (The app's own functions, which run as the database, aren't checked here: they check permissions themselves.)
create or replace function public.cb_entries_guard()
returns trigger language plpgsql as $$
declare resultcols text[] := array['result','result_at','photo_path','photo_at','photo_by','photo_removed_at'];
        beltcols   text[] := array['belt_from','belt_to','to_programme','efc_belt_fix'];
begin
  if current_user <> 'authenticated' then return coalesce(new, old); end if;
  if tg_op in ('INSERT', 'DELETE') then
    if not public.app_can('cb', 'days') then raise exception 'Your login cannot add or remove students on grading days.' using errcode = '42501'; end if;
    return coalesce(new, old);
  end if;
  if (new.result, new.result_at, new.photo_path, new.photo_at, new.photo_by, new.photo_removed_at) is distinct from
     (old.result, old.result_at, old.photo_path, old.photo_at, old.photo_by, old.photo_removed_at)
     and not public.app_can('cb', 'results') then
    raise exception 'Your login cannot enter results or photos.' using errcode = '42501';
  end if;
  -- anything changed other than results/photos
  if (to_jsonb(new) - resultcols) is distinct from (to_jsonb(old) - resultcols) then
    if (to_jsonb(new) - resultcols - beltcols) is distinct from (to_jsonb(old) - resultcols - beltcols) then
      -- a change outside the belt columns: full grading-day permission
      if not public.app_can('cb', 'days') then raise exception 'Your login cannot change grading days.' using errcode = '42501'; end if;
    else
      -- only the belt columns changed: "days" or the narrower "belts"
      if not public.app_can('cb', 'days', 'belts') then raise exception 'Your login cannot edit student belts.' using errcode = '42501'; end if;
    end if;
  end if;
  return new;
end $$;
do $$ begin
  if to_regclass('public.cb_entries') is not null then
    drop trigger if exists cb_entries_guard on public.cb_entries;
    create trigger cb_entries_guard before insert or update or delete on public.cb_entries for each row execute function public.cb_entries_guard();
  end if;
end $$;

-- The apps' functions: each checks the permission it needs
do $$
declare r record; def text;
begin
  for r in select * from (values
    ('cb_bb_sync', 'public.app_can(''cb'', ''days'')'), ('cb_bbc_invite', 'public.app_can(''cb'', ''readiness'')'), ('cb_bbc_written', 'public.app_can(''cb'', ''readiness'')'),
    ('cb_check_in', 'public.app_can(''cb'', ''results'', ''readiness'')'), ('cb_import_efc', 'public.app_can(''cb'', ''days'')'), ('cb_seq_set', 'public.app_can(''cb'', ''text_followup'', ''text_invite'', ''texts'')'),
    ('cb_seq_switch', 'public.app_can(''cb'', ''set_wording'', ''set_general'', ''settings'')'), ('cb_set_contact', 'public.app_can(''cb'', ''days'')'), ('cb_set_paid', 'public.app_can(''cb'', ''payments'')'),
    ('prep_activate_cycle', 'public.app_can(''bb'', ''settings'')'), ('prep_assign_missing_dan_numbers', 'public.app_can(''bb'', ''settings'')'),
    ('prep_delete_students', 'public.app_can(''bb'', ''settings'')'), ('prep_efc_link', 'public.app_can(''bb'', ''settings'')'),
    ('prep_essay_allow_late', 'public.app_can(''bb'', ''essays'', ''readiness'')'), ('prep_essay_links', 'public.app_can(''bb'', ''essays'', ''readiness'')'),
    ('prep_polo_guard', 'public.app_can(''bb'', ''payments'')'), ('prep_polo_links', 'public.app_can(''bb'', ''polos'')'),
    ('prep_record_session_payment', 'public.app_can(''bb'', ''attendance'', ''payments'')'), ('prep_session_fees', 'public.app_can(''bb'', ''attendance'', ''payments'')'),
    ('prep_score_stamp', 'public.app_can(''bb'', ''admin'')'), ('prep_send_to_card_software', 'public.app_can(''bb'', ''idcards'')'),
    ('prep_set_card_link', 'public.app_can(''bb'', ''idcards'')'), ('prep_unlinked_cards', 'public.app_can(''bb'', ''idcards'')'),
    ('prep_set_classes', 'public.app_can(''bb'', ''attendance'')'), ('prep_set_grading', 'public.app_can(''bb'', ''grading'', ''results'')'),
    ('prep_start_new_cycle', 'public.app_can(''bb'', ''settings'')')
  ) v(fn, chk) loop
    for def in select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.fn loop
      if def ~ 'prep_has_role\(' then
        execute regexp_replace(def, '(public\.)?prep_has_role\([^)]*\)', r.chk, 'g');
      end if;
    end loop;
  end loop;
end $$;

-- Row security: each table checks the permission for what it holds
do $$
declare r record;
begin
  for r in select * from (values
    ('cb_approvals','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_belts','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_calls','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_days','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_efc_runs','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_entries','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_messages','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_outbox','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_prep_bookings','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_programmes','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_seq_log','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_seq_steps','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_settings','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_skip','read','SELECT',$q$app_any('cb')$q$,null),
    ('cb_approvals','write','ALL',$q$app_can('cb', 'readiness')$q$,$q$app_can('cb', 'readiness')$q$),
    ('cb_belts','write','ALL',$q$app_can('cb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('cb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('cb_programmes','write','ALL',$q$app_can('cb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('cb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('cb_settings','write','ALL',$q$app_can('cb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('cb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('cb_seq_steps','write','UPDATE',$q$app_can('cb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('cb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('cb_days','write','ALL',$q$app_can('cb', 'days')$q$,$q$app_can('cb', 'days')$q$),
    ('cb_entries','write','ALL',$q$app_can('cb', 'days', 'results', 'belts')$q$,$q$app_can('cb', 'days', 'results', 'belts')$q$),
    ('efc_grades','read','SELECT',$q$(app_can('cb', 'days', 'belts', 'readiness', 'texts', 'results', 'calls', 'settings', 'text_invite', 'text_result', 'text_followup', 'set_general', 'set_fees', 'set_wording') or app_any('awards') or app_any('bb'))$q$,null),
    ('efc_members','read','SELECT',$q$(app_can('cb', 'days', 'belts', 'readiness', 'texts', 'results', 'calls', 'settings', 'text_invite', 'text_result', 'text_followup', 'set_general', 'set_fees', 'set_wording') or app_any('awards') or app_any('bb'))$q$,null),
    ('lsa_awards','read','SELECT',$q$app_any('awards')$q$,null),
    ('lsa_members','read','SELECT',$q$app_any('awards')$q$,null),
    ('lsa_runs','read','SELECT',$q$app_any('awards')$q$,null),
    ('lsa_settings','read','SELECT',$q$app_any('awards')$q$,null),
    ('lsa_awards','write','ALL',$q$app_can('awards', 'edit')$q$,$q$app_can('awards', 'edit')$q$),
    ('lsa_members','remove','DELETE',$q$(app_can('awards', 'edit') and member_key like 'manual:%')$q$,null),
    ('lsa_members','add','INSERT',null,$q$(app_can('awards', 'edit') and member_key like 'manual:%')$q$),
    ('lsa_members','change','UPDATE',$q$app_can('awards', 'edit')$q$,$q$app_can('awards', 'edit')$q$),
    ('lsa_memory_tokens','staff add','INSERT',null,$q$app_can('awards', 'edit')$q$),
    ('lsa_memory_tokens','staff read','SELECT',$q$app_can('awards', 'edit')$q$,null),
    ('lsa_settings','write','UPDATE',$q$app_can('awards', 'admin')$q$,$q$app_can('awards', 'admin')$q$),
    ('prep_attendance','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_calls','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_certificates','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_class_requirements','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_cycles','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_dan_counters','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_dan_numbers','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_enrolments','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_essay_questions','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_grading','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_grading_fee_rates','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_id_cards','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_message_templates','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_nurture_log','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_nurture_runs','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_nurture_state','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_nurture_steps','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_print_event_notes','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_readiness','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_readiness_history','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_report_cards','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_score_notes','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_score_sheets','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_scores','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_sessions','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_settings','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_students','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_time_groups','read','SELECT',$q$app_any('bb')$q$,null),
    ('prep_attendance','change','UPDATE',$q$app_can('bb', 'attendance')$q$,$q$app_can('bb', 'attendance')$q$),
    ('prep_audit_log','read','SELECT',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,null),
    ('prep_calls','write','ALL',$q$app_can('bb', 'calls', 'grading', 'texts')$q$,$q$app_can('bb', 'calls', 'grading', 'texts')$q$),
    ('prep_nurture_log','write','ALL',$q$app_can('bb', 'calls', 'grading', 'texts')$q$,$q$app_can('bb', 'calls', 'grading', 'texts')$q$),
    ('prep_nurture_runs','write','ALL',$q$app_can('bb', 'calls', 'grading', 'texts')$q$,$q$app_can('bb', 'calls', 'grading', 'texts')$q$),
    ('prep_nurture_state','write','ALL',$q$app_can('bb', 'calls', 'grading', 'texts')$q$,$q$app_can('bb', 'calls', 'grading', 'texts')$q$),
    ('prep_certificates','write','ALL',$q$app_can('bb', 'certificates')$q$,$q$app_can('bb', 'certificates')$q$),
    ('prep_class_requirements','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_cycles','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_dan_counters','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_dan_numbers','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_enrolments','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_essay_questions','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_grading_fee_rates','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_message_templates','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_nurture_steps','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_score_sheets','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_sessions','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_students','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_time_groups','write','ALL',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_settings','write','UPDATE',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_essay_versions','read','SELECT',$q$app_can('bb', 'essays', 'readiness')$q$,null),
    ('prep_essays','read','SELECT',$q$app_can('bb', 'essays', 'readiness')$q$,null),
    ('prep_essays','mark','UPDATE',$q$app_can('bb', 'essays', 'readiness')$q$,$q$app_can('bb', 'essays', 'readiness')$q$),
    ('prep_grading','write','ALL',$q$app_can('bb', 'grading', 'results')$q$,$q$app_can('bb', 'grading', 'results')$q$),
    ('prep_report_cards','write','ALL',$q$app_can('bb', 'grading', 'results')$q$,$q$app_can('bb', 'grading', 'results')$q$),
    ('prep_id_cards','write','ALL',$q$app_can('bb', 'idcards')$q$,$q$app_can('bb', 'idcards')$q$),
    ('prep_print_event_notes','write','ALL',$q$app_can('bb', 'idcards')$q$,$q$app_can('bb', 'idcards')$q$),
    ('prep_messages','read','SELECT',$q$app_can('bb', 'text_invite', 'text_result', 'text_followup', 'texts', 'readiness')$q$,null),
    ('prep_payment_transactions','add','INSERT',null,$q$app_can('bb', 'payments')$q$),
    ('prep_payment_transactions','read','SELECT',$q$app_can('bb', 'payments')$q$,null),
    ('prep_payments','read','SELECT',$q$app_can('bb', 'payments')$q$,null),
    ('prep_payments','change','UPDATE',$q$app_can('bb', 'payments')$q$,$q$app_can('bb', 'payments')$q$),
    ('prep_polo_orders','remove','DELETE',$q$(app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings') and status = any (array['invited','pending','cancelled']))$q$,null),
    ('prep_polo_orders','add','INSERT',null,$q$app_can('bb', 'polos')$q$),
    ('prep_polo_orders','read','SELECT',$q$app_can('bb', 'polos', 'payments')$q$,null),
    ('prep_polo_orders','change','UPDATE',$q$app_can('bb', 'polos', 'payments')$q$,$q$app_can('bb', 'polos', 'payments')$q$),
    ('prep_polo_settings','read','SELECT',$q$app_can('bb', 'polos', 'payments')$q$,null),
    ('prep_polo_settings','write','UPDATE',$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$,$q$app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings')$q$),
    ('prep_readiness','change','UPDATE',$q$app_can('bb', 'readiness')$q$,$q$app_can('bb', 'readiness')$q$),
    ('prep_report_templates','write','ALL',$q$(app_can('bb', 'set_general', 'set_fees', 'set_wording', 'settings') or created_by = prep_email())$q$,$q$app_any('bb')$q$),
    ('prep_report_templates','read','SELECT',$q$(app_any('bb') and (audience = 'instructor' or app_can('bb', 'payments', 'grading', 'certificates', 'idcards', 'results')))$q$,null),
    ('prep_score_notes','write','ALL',$q$(app_can('bb', 'admin') or (app_can('bb', 'scoring', 'grading') and examiner = prep_email()))$q$,$q$(app_can('bb', 'admin') or (app_can('bb', 'scoring', 'grading') and examiner = prep_email()))$q$),
    ('prep_scores','write','ALL',$q$(app_can('bb', 'admin') or (app_can('bb', 'scoring', 'grading') and examiner = prep_email()))$q$,$q$(app_can('bb', 'admin') or (app_can('bb', 'scoring', 'grading') and examiner = prep_email()))$q$)
  ) v(t, n, cmd, u, w) loop
    if to_regclass('public.' || r.t) is null then continue; end if;   -- an app not set up here yet
    execute format('drop policy if exists %I on public.%I', r.n, r.t);
    execute format('create policy %I on public.%I for %s to authenticated', r.n, r.t, r.cmd)
      || coalesce(' using (' || r.u || ')', '') || coalesce(' with check (' || r.w || ')', '');
  end loop;
end $$;
