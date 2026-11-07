-- Black Belt Prep: update 16 (polo shirts are a year shirt)
-- Run once in Supabase > SQL Editor, after prep-update-15.sql. Safe to run again.
-- The polo is the year's shirt (e.g. the 2026 shirt): the back has the names of everyone who passed Probationary
-- Black Belt or a Dan that year. Each student who graded that year can order one; families only choose the size
-- and how many. Each order belongs to a year.

alter table public.prep_polo_orders add column if not exists year int;
update public.prep_polo_orders set year = extract(year from created_at)::int where year is null;
alter table public.prep_polo_orders alter column year set not null;
create index if not exists prep_polo_orders_year_idx on public.prep_polo_orders (year);

-- The year of a passed grading: its grading date, else its cycle's, else when the result was saved
create or replace function public.prep_grading_year(g public.prep_grading) returns int
language sql stable set search_path = public as $$
  select extract(year from coalesce(g.grading_date, (select c.grading_date from prep_cycles c where c.cycle_id = g.cycle_id), g.updated_at::date))::int
$$;

-- Personal links for a year's shirt (grading staff): one order each per year; existing ones are kept.
drop function if exists public.prep_polo_links(text[]);
create or replace function public.prep_polo_links(p_students text[], p_year int)
returns setof public.prep_polo_orders language plpgsql security definer set search_path = public as $$
declare sid text; rk text;
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
    insert into prep_polo_orders (student_id, year, rank, token, name_on_back, created_by)
      select s.student_id, p_year, coalesce(rk, s.belt_rank), replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
             left(coalesce(nullif(trim(s.certificate_name), ''), s.full_name), 24), public.prep_email()
        from prep_students s where s.student_id = sid;
  end loop;
  return query select * from prep_polo_orders o where o.student_id = any (p_students) and o.year = p_year and o.status <> 'cancelled' order by o.created_at;
end $$;
revoke all on function public.prep_polo_links(text[], int) from public, anon;
grant execute on function public.prep_polo_links(text[], int) to authenticated;

update public.prep_message_templates set body = 'Congratulations {first_name} on your {belt}! Order your AMA {year} black belt polo here: {link} - AMA Marrickville'
 where kind = 'polo' and body like 'Congratulations {first_name} on your {belt}! Order your AMA black belt polo with your name on the back here:%';
