-- efc-members-ref-idx.sql (21 Nov 2026): look members up by EFC reference quickly (helpers page, black belt links).
create index if not exists efc_members_ref_idx on public.efc_members (efc_reference);
