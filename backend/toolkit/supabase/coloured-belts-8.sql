-- AMA Toolkit: coloured belt grading, update 8 (staff can fix a student's mobile and email)
-- Run once in Supabase > SQL Editor, after coloured-belts-7.sql. Safe to run again.
-- Grading staff can change a student's mobile and email from the student or grading-day screens. Texts and emails
-- then go to the new details. A number or email typed in here is kept: later EFC updates and imports don't overwrite it.

alter table public.efc_members add column if not exists contact_edited_at timestamptz;
alter table public.efc_members add column if not exists contact_edited_by text;

-- Change a student's mobile and email. An empty value clears it (texts and emails then go to the parent's, if EFC has one).
create or replace function public.cb_set_contact(p_member text, p_phone text, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ph text := nullif(regexp_replace(coalesce(p_phone, ''), '[^\d+]', '', 'g'), ''); em text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  if not public.prep_has_role('grading') then raise exception 'Only grading staff can change contact details.'; end if;
  -- Australian numbers: 04xx xxx xxx, +614xx xxx xxx, or a landline (02 xxxx xxxx)
  if ph is not null then
    if ph ~ '^\+61\d{9}$' then ph := '0' || substr(ph, 4);
    elsif ph ~ '^61\d{9}$' then ph := '0' || substr(ph, 3);
    elsif ph ~ '^[2-478]\d{8}$' then ph := '0' || ph;
    end if;
    if ph !~ '^0[2-478]\d{8}$' then raise exception 'That mobile number doesn''t look right. Use 10 digits, like 0412 345 678.'; end if;
  end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email doesn''t look right.'; end if;
  update efc_members set phone = ph, email = em, contact_edited_at = now(),
    contact_edited_by = public.prep_email(), updated_at = now()
  where member_key = p_member;
  if not found then raise exception 'Student not found.'; end if;
  return jsonb_build_object('phone', ph, 'email', em);
end $$;
revoke all on function public.cb_set_contact(text, text, text) from public, anon;
grant execute on function public.cb_set_contact(text, text, text) to authenticated;

-- EFC imports keep a mobile or email typed in by staff
do $$
declare d text := pg_get_functiondef('public.cb_import_efc(jsonb)'::regprocedure);
begin
  if position('contact_edited_at' in d) = 0 then
    d := replace(d, 'phone = coalesce(nullif(btrim(r->>''phone''), ''''), phone),',
      'phone = case when contact_edited_at is null then coalesce(nullif(btrim(r->>''phone''), ''''), phone) else phone end,');
    d := replace(d, 'email = coalesce(nullif(btrim(r->>''email''), ''''), email),',
      'email = case when contact_edited_at is null then coalesce(nullif(btrim(r->>''email''), ''''), email) else email end,');
    execute d;
  end if;
end $$;
