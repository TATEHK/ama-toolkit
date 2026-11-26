-- bb-oath-2: one row per oath for Mark's hub (AMA OS), read through the ama_os_app login.
-- No token; a plain status; signature_png is a data: URL ready for <img src>.
create or replace view ama_os.bb_oath as
select o.oath_id,
       o.member_key,
       o.efc_reference,
       o.full_name,
       o.rank,
       o.grading_date,
       case when o.signed_at is not null then 'signed' when o.sent_at is not null then 'sent' else 'waiting' end as status,
       o.sent_at,
       o.name          as signed_name,
       o.signed_date,
       o.signed_at,
       o.signature_png,
       o.signature_path,
       o.oath_version
from public.bb_oath o;
comment on view ama_os.bb_oath is 'Black Belt Oath per member (from public.bb_oath). status: signed | sent (link emailed, not signed yet) | waiting. signature_png is a data: URL ready for <img src>.';
revoke all on ama_os.bb_oath from public, anon, authenticated;
grant select on ama_os.bb_oath to ama_os_app;
