-- AMA Toolkit: coloured belts update 26. The coloured belt student list never empties when EFC leaves out schools.
--
-- cb_students only lists members at the five schools. On 8 Nov 2026 an EFC update blanked every school and the list
-- dropped to 17. Update 24 stops updates blanking a known school; this also falls back to the school in the EFC
-- reference (efc_school, update 25) for anyone EFC never gave a school, so they're listed (and filtered) correctly.
create or replace view public.cb_students as
 SELECT m.member_key,
    g.programme,
    m.full_name,
    m.guardian_name,
    COALESCE(m.phone, m.guardian_phone) AS phone,
    COALESCE(m.email, m.guardian_email) AS email,
    m.efc_reference,
    replace(m.member_key, 'efc:'::text, ''::text) AS efc_id,
    sch.school AS location,
    g.belt,
    b.next_belt,
    b.next_programme,
    b.up_belt,
    b.up_programme,
    b.sort AS belt_sort,
    b.colour,
    g.promoted_on,
    ((CURRENT_DATE - g.promoted_on) / 7) AS weeks_at_belt,
    COALESCE(g.attended_since_promoted, 0) AS classes,
    b.classes_needed,
    (COALESCE(g.attended_since_promoted, 0) >= b.classes_needed) AS enough_classes,
    b.weeks_between,
    (((CURRENT_DATE - g.promoted_on) / 7) >= b.weeks_between) AS enough_time,
    CASE WHEN (a.belt = g.belt) THEN a.status ELSE NULL::text END AS approval,
    CASE WHEN (a.belt = g.belt) THEN a.note ELSE NULL::text END AS approval_note,
    CASE WHEN (a.belt = g.belt) THEN a.decided_by ELSE NULL::text END AS decided_by,
    g.updated_at AS efc_updated_at,
    m.date_of_birth,
    CASE WHEN (m.date_of_birth ~ '^\d{4}-\d{2}-\d{2}'::text) THEN (EXTRACT(year FROM age((CURRENT_DATE)::timestamp with time zone, ((left(m.date_of_birth, 10))::date)::timestamp with time zone)))::integer ELSE NULL::integer END AS age,
    COALESCE((m.bbc_seen_at > (now() - '3 days'::interval)), false) AS black_belt_club,
    m.bbc_invited_at,
    m.bbc_invited_by,
    m.bbc_written_at,
    m.bbc_written_by
   FROM efc_grades g
     JOIN efc_members m ON m.member_key = g.member_key
     CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(btrim(m.location), ''),
        CASE split_part(m.efc_reference, '-', 2) WHEN '023' THEN 'Marrickville' WHEN '256' THEN 'Sydenham' WHEN '257' THEN 'West'
          WHEN '258' THEN 'Concord' WHEN '3096' THEN 'Sylvania' END) AS school) sch
     JOIN cb_belts b ON b.programme = g.programme AND b.belt = g.belt
     LEFT JOIN cb_approvals a ON a.member_key = g.member_key AND a.programme = g.programme
  WHERE m.kind = 'member'::text AND sch.school = ANY (ARRAY['Marrickville'::text, 'Sydenham'::text, 'Concord'::text, 'West'::text, 'Sylvania'::text])
    AND NOT (EXISTS (SELECT 1 FROM cb_skip k WHERE k.member_key = m.member_key AND (k.until IS NULL OR k.until >= CURRENT_DATE)));
