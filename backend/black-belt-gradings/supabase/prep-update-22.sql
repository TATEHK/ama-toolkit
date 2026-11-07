-- Black Belt Gradings update 22: short polo links (app.train-ama.com/polo#<code>).
-- New orders get a 10-character code instead of a 64-character token. Run once in Supabase > SQL Editor.

create or replace function public.prep_short_code(n int default 10) returns text
  language sql volatile set search_path = public, extensions as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', 1 + (get_byte(b, i) % 57), 1), '')
  from (select gen_random_bytes(n) b) x, generate_series(0, n - 1) i
$$;

create or replace function public.prep_polo_links(p_students text[], p_year int)
returns setof public.prep_polo_orders language plpgsql security definer set search_path = public as $$
declare sid text; rk text; code text;
begin
  if not public.prep_has_role('grading') then raise exception 'Your login cannot make polo links.' using errcode = '42501'; end if;
  if p_year is null or p_year < 2000 or p_year > 2100 then raise exception 'Choose the year.'; end if;
  foreach sid in array coalesce(p_students, '{}') loop
    if exists (select 1 from prep_polo_orders o where o.student_id = sid and o.year = p_year and o.status <> 'cancelled') then continue; end if;
    rk := null;
    select g.target_rank into rk from prep_grading g where g.student_id = sid and g.result = 'passed'
      and g.target_rank in ('Probationary Black Belt', '1st Dan Black Belt', '2nd Dan', '3rd Dan', '4th Dan', '5th Dan', '6th Dan', '7th Dan', '8th Dan', '9th Dan')
      and public.prep_grading_year(g) = p_year
      order by g.updated_at desc nulls last limit 1;
    loop code := public.prep_short_code(10); exit when not exists (select 1 from prep_polo_orders where token = code); end loop;
    insert into prep_polo_orders (student_id, year, rank, token, name_on_back, created_by)
      select s.student_id, p_year, coalesce(rk, s.belt_rank), code,
             left(coalesce(nullif(trim(s.certificate_name), ''), s.full_name), 24), public.prep_email()
        from prep_students s where s.student_id = sid;
  end loop;
  return query select * from prep_polo_orders o where o.student_id = any (p_students) and o.year = p_year and o.status <> 'cancelled' order by o.created_at;
end $$;
revoke all on function public.prep_polo_links(text[], int) from public, anon;
grant execute on function public.prep_polo_links(text[], int) to authenticated;

-- Orders not yet paid get a short code too (no polo links had been sent when this ran).
update public.prep_polo_orders set token = public.prep_short_code(10) where status = 'pending' and length(token) > 16;
