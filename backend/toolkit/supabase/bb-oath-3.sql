-- bb-oath-3: Black Belt Gradings staff (app_permissions 'bb': admin, grading or results) can read oaths too,
-- for the Oaths screen in the prep system. Coloured Belts results staff keep their access.
drop policy if exists "bb oath staff read" on public.bb_oath;
create policy "bb oath staff read" on public.bb_oath for select to authenticated
  using (exists (select 1 from public.app_permissions p
                 where p.email = lower(auth.jwt() ->> 'email')
                   and ((p.app = 'cb' and p.perm in ('admin', 'results', 'text_result'))
                     or (p.app = 'bb' and p.perm in ('admin', 'grading', 'results')))));
drop policy if exists "bb oath read" on storage.objects;
create policy "bb oath read" on storage.objects for select to authenticated
  using (bucket_id = 'bb-oath' and exists (select 1 from public.app_permissions p
         where p.email = lower(auth.jwt() ->> 'email')
           and ((p.app = 'cb' and p.perm in ('admin', 'results', 'text_result'))
             or (p.app = 'bb' and p.perm in ('admin', 'grading', 'results')))));
