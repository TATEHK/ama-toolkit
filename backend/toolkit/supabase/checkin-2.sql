-- Check-in, better (stations at /grading/check-in and the floor's own kiosk)
--  * the station list matches the floor: anyone paid OR booked (e.g. paid by EFC invoice) can check in
--  * each student carries their line/group (cone + title), the belt they're going for, and a family tag (a short hash,
--    never the email/phone) so a parent can check in brothers and sisters in one go
--  * cb_checkin_mark(p_code, p_entry, p_on): p_on false is "Not you? Undo", allowed only within 10 minutes of that
--    check-in, so a public station can't take people off the roll later

create or replace function public.cb_checkin_feed(p_code text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare d public.cb_days%rowtype; out jsonb;
begin
  select * into d from public.cb_days where checkin_code = upper(trim(coalesce(p_code,'')));
  if not found then return jsonb_build_object('error','wrong_code'); end if;
  select jsonb_build_object(
    'day', jsonb_build_object('date', d.grading_date, 'location', d.location, 'bb', coalesce(d.bb,false)),
    'students', (select coalesce(jsonb_agg(jsonb_build_object(
        'entry_id', e.entry_id,
        'name', split_part(e.full_name,' ',1) || case when split_part(e.full_name,' ',2) <> '' then ' ' || left(split_part(e.full_name,' ',2),1) || '.' else '' end,
        'first', split_part(e.full_name,' ',1),
        'search', lower(e.full_name),
        'belt', e.belt_from, 'belt_to', e.belt_to, 'loc', m.location,
        'cone', g.cone, 'gtitle', g.opts->>'title',
        'fam', case when coalesce(nullif(m.guardian_email,''), m.guardian_phone, '') <> '' then left(md5('ama-fam:' || lower(coalesce(nullif(m.guardian_email,''), m.guardian_phone))), 12) end,
        'checked_in', e.checked_in_at is not null,
        'undo_ok', e.checked_in_at is not null and e.checked_in_at > now() - interval '10 minutes'
      ) order by e.full_name), '[]'::jsonb)
      from public.cb_entries e
      left join public.efc_members m on m.member_key = e.member_key
      left join lateral (select g.cone, g.opts from public.cb_groups g where g.day_id = d.day_id and g.slots @> to_jsonb(e.entry_id::text) limit 1) g on true
      where e.day_id = d.day_id and (e.paid or e.booked_at is not null) and e.cant_make_at is null)
  ) into out;
  return out;
end $$;

drop function if exists public.cb_checkin_mark(text, uuid);
create or replace function public.cb_checkin_mark(p_code text, p_entry uuid, p_on boolean default true)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare d public.cb_days%rowtype; e public.cb_entries%rowtype; g record;
begin
  select * into d from public.cb_days where checkin_code = upper(trim(coalesce(p_code,'')));
  if not found then return jsonb_build_object('error','wrong_code'); end if;
  select * into e from public.cb_entries where entry_id = p_entry and day_id = d.day_id and (paid or booked_at is not null);
  if not found then return jsonb_build_object('error','not_found'); end if;
  if coalesce(p_on, true) then
    if e.checked_in_at is null then update public.cb_entries set checked_in_at = now() where entry_id = e.entry_id; end if;
  else
    if e.checked_in_at is not null and e.checked_in_at < now() - interval '10 minutes' then return jsonb_build_object('error','too_late'); end if;
    update public.cb_entries set checked_in_at = null where entry_id = e.entry_id;
    return jsonb_build_object('ok', true, 'undone', true);
  end if;
  select gg.cone, gg.opts into g from public.cb_groups gg where gg.day_id = d.day_id and gg.slots @> to_jsonb(e.entry_id::text) limit 1;
  return jsonb_build_object('ok', true, 'name', split_part(e.full_name,' ',1), 'belt_from', e.belt_from, 'belt_to', e.belt_to,
    'cone', g.cone, 'gtitle', g.opts->>'title', 'bb', coalesce(d.bb,false));
end $$;
grant execute on function public.cb_checkin_feed(text) to anon, authenticated;
grant execute on function public.cb_checkin_mark(text, uuid, boolean) to anon, authenticated;

-- Applied after: families are linked by the member's own email (guardian_email/phone are almost always empty in EFC),
-- for both the station's family tag and the floor's kiosk (cb_floor_load 'family'). Run as a DO block that swaps the
-- expression inside the live function definitions:
--   lower(coalesce(nullif(m.guardian_email,''), nullif(m.email,''), nullif(m.guardian_phone,''), m.phone, ''))
