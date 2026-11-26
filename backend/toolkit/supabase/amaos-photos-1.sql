-- amaos-photos-1: grading photos for Mark's hub (AMA OS), so they can be copied across before the 30-day clean-up.
-- One row per photo per student: each student's own photo (cb_entries.photo_path), and each group photo for their
-- day (cb_group_photos) once per student it covers. A 'session' group photo covers everyone on the day; a belt/range
-- one covers students whose belt_to rank is in its range (same rule as the family photo page). Only students who
-- were checked in, have a result, or have their own photo count as "in" a group photo.
-- The images themselves stay private: AMA OS asks cb { act: 'amaos-photo', path } for a 1-hour signed URL.
create or replace view ama_os.grading_photos as
select 'student:' || e.entry_id::text      as photo_id,
       'student'::text                     as kind,
       e.member_key,
       m.efc_reference,
       e.full_name,
       e.belt_to,
       d.grading_date,
       d.location,
       e.photo_path,
       coalesce(e.photo_at, e.created_at)  as photo_at
from public.cb_entries e
join public.cb_days d on d.day_id = e.day_id
left join public.efc_members m on m.member_key = e.member_key
where e.photo_path is not null
union all
select 'group:' || g.group_photo_id::text || ':' || e.entry_id::text,
       'group',
       e.member_key,
       m.efc_reference,
       e.full_name,
       e.belt_to,
       d.grading_date,
       d.location,
       g.photo_path,
       g.created_at
from public.cb_group_photos g
join public.cb_days d on d.day_id = g.day_id
join public.cb_entries e on e.day_id = g.day_id
left join public.efc_members m on m.member_key = e.member_key
where g.photo_path is not null
  and (e.checked_in_at is not null or e.result is not null or e.photo_path is not null)
  and (g.scope = 'session'
       or (g.belt_from_rank is not null and g.belt_to_rank is not null
           and public.cb_belt_rank(e.belt_to) between g.belt_from_rank and g.belt_to_rank));
comment on view ama_os.grading_photos is 'Grading photos per student for AMA OS. kind: student | group. photo_at: when taken (fetch newer ones). Images: POST cb { act: ''amaos-photo'', path } with x-amaos-sync-key for a 1-hour signed URL. Storage deletes photos after 30 days.';
revoke all on ama_os.grading_photos from public, anon, authenticated;
grant select on ama_os.grading_photos to ama_os_app;

-- cb checks AMA OS's sync key against the vault (like cb_cron_ok). Service role only.
create or replace function public.amaos_sync_ok(p_key text) returns boolean
language plpgsql stable security definer set search_path = public, vault as $$
begin
  return coalesce(p_key <> '' and p_key = (select decrypted_secret from vault.decrypted_secrets where name = 'ama_os_sync_key' limit 1), false);
end $$;
revoke all on function public.amaos_sync_ok(text) from public, anon, authenticated;
grant execute on function public.amaos_sync_ok(text) to service_role;
