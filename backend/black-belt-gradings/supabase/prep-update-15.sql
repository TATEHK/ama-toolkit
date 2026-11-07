-- Black Belt Prep: update 15 (black belt polo shirt orders)
-- Run once in Supabase > SQL Editor, after prep-update-14.sql. Safe to run again.
-- Everyone who passes a Dan grading can order an AMA polo with their name on the back. Staff make each family a
-- personal link (and can text it); the family picks the size, checks the name and pays by card through Stripe.
-- The "polo" Supabase function takes the payment and marks the order paid with its size. Staff see who has
-- paid and the sizes, mark shirts ordered and handed out, and download the supplier list.

-- Price, sizes, and whether ordering is open (one row)
create table if not exists public.prep_polo_settings (
  id        int primary key default 1 check (id = 1),
  price     numeric(8,2) not null default 45 check (price >= 0),
  sizes     text[] not null default array['Kids 6', 'Kids 8', 'Kids 10', 'Kids 12', 'Kids 14', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'],
  is_open   boolean not null default true,
  note      text,                                 -- shown to families (e.g. "Shirts arrive about 4 weeks after ordering")
  updated_at timestamptz not null default now()
);
insert into public.prep_polo_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.prep_polo_orders (
  order_id       uuid primary key default gen_random_uuid(),
  student_id     text not null references public.prep_students on update cascade on delete cascade,
  rank           text,                            -- the Dan they passed (e.g. 1st Dan Black Belt)
  token          text not null unique,            -- the family's personal link
  name_on_back   text check (name_on_back is null or length(trim(name_on_back)) between 1 and 24),
  size           text,
  qty            int not null default 1 check (qty between 1 and 5),
  price          numeric(8,2),                    -- price per shirt when they paid
  amount         numeric(8,2),                    -- total paid
  status         text not null default 'invited' check (status in ('invited', 'pending', 'paid', 'ordered', 'delivered', 'cancelled')),
  stripe_session text,
  stripe_payment text,
  paid_at        timestamptz,
  paid_how       text,                            -- 'stripe' or how staff recorded it (cash, EFTPOS...)
  paid_by        text,                            -- staff member who recorded a payment by hand
  ordered_at     timestamptz,
  delivered_at   timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     text
);
create index if not exists prep_polo_orders_student_idx on public.prep_polo_orders (student_id);
create unique index if not exists prep_polo_orders_session_idx on public.prep_polo_orders (stripe_session) where stripe_session is not null;

alter table public.prep_polo_settings enable row level security;
alter table public.prep_polo_orders enable row level security;
drop policy if exists "read" on public.prep_polo_settings;
drop policy if exists "write" on public.prep_polo_settings;
create policy "read"  on public.prep_polo_settings for select to authenticated using (public.prep_has_role('grading', 'payments'));
create policy "write" on public.prep_polo_settings for update to authenticated using (public.prep_has_role('admin')) with check (public.prep_has_role('admin'));
drop policy if exists "read" on public.prep_polo_orders;
drop policy if exists "add" on public.prep_polo_orders;
drop policy if exists "change" on public.prep_polo_orders;
drop policy if exists "remove" on public.prep_polo_orders;
-- Grading staff run the orders; payments staff see who has paid. Families never read the table (the function does).
create policy "read"   on public.prep_polo_orders for select to authenticated using (public.prep_has_role('grading', 'payments'));
create policy "add"    on public.prep_polo_orders for insert to authenticated with check (public.prep_has_role('grading'));
create policy "change" on public.prep_polo_orders for update to authenticated using (public.prep_has_role('grading', 'payments')) with check (public.prep_has_role('grading', 'payments'));
create policy "remove" on public.prep_polo_orders for delete to authenticated using (public.prep_has_role('admin') and status in ('invited', 'pending', 'cancelled'));
revoke all on public.prep_polo_orders, public.prep_polo_settings from anon;
grant select, insert, update, delete on public.prep_polo_orders to authenticated;
grant select, update on public.prep_polo_settings to authenticated;

-- Payments are only marked by Stripe (through the function) or by payments staff by hand.
create or replace function public.prep_polo_guard() returns trigger language plpgsql as $$
begin
  -- The polo function (service role) records card payments
  if current_user in ('postgres', 'service_role', 'supabase_admin')
     or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', current_setting('request.jwt.claim.role', true)) = 'service_role' then return new; end if;
  if (new.paid_at is distinct from old.paid_at or new.amount is distinct from old.amount or new.paid_how is distinct from old.paid_how
      or new.stripe_session is distinct from old.stripe_session or new.stripe_payment is distinct from old.stripe_payment
      or (new.status = 'paid' and old.status is distinct from 'paid' and old.status not in ('ordered', 'delivered')))
     and not public.prep_has_role('payments') then
    raise exception 'Only payments staff can mark a polo paid.' using errcode = '42501';
  end if;
  if old.stripe_payment is not null and new.stripe_payment is distinct from old.stripe_payment then
    raise exception 'A card payment cannot be changed here. Refund it in Stripe.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists prep_polo_guard on public.prep_polo_orders;
create trigger prep_polo_guard before update on public.prep_polo_orders for each row execute function public.prep_polo_guard();

-- Personal links for students (grading staff): one open order each; existing ones are kept.
create or replace function public.prep_polo_links(p_students text[])
returns setof public.prep_polo_orders language plpgsql security definer set search_path = public as $$
declare sid text; rk text;
begin
  if not public.prep_has_role('grading') then raise exception 'Your login cannot make polo links.' using errcode = '42501'; end if;
  foreach sid in array coalesce(p_students, '{}') loop
    if exists (select 1 from prep_polo_orders o where o.student_id = sid and o.status in ('invited', 'pending')) then continue; end if;
    select g.target_rank into rk from prep_grading g where g.student_id = sid and g.result = 'passed'
      and g.target_rank in ('1st Dan Black Belt', '2nd Dan', '3rd Dan', '4th Dan', '5th Dan', '6th Dan', '7th Dan', '8th Dan', '9th Dan')
      order by g.updated_at desc nulls last limit 1;
    insert into prep_polo_orders (student_id, rank, token, name_on_back, created_by)
      select s.student_id, coalesce(rk, s.belt_rank), replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
             left(coalesce(nullif(trim(s.certificate_name), ''), s.full_name), 24), public.prep_email()
        from prep_students s where s.student_id = sid;
  end loop;
  return query select * from prep_polo_orders o where o.student_id = any (p_students) and o.status in ('invited', 'pending') order by o.created_at;
end $$;
revoke all on function public.prep_polo_links(text[]) from public, anon;
grant execute on function public.prep_polo_links(text[]) to authenticated;

-- A text message for polo links
alter table public.prep_message_templates drop constraint if exists prep_message_templates_kind_check;
alter table public.prep_message_templates add constraint prep_message_templates_kind_check check (kind in ('invite', 'congrats', 'not_ready', 'essay', 'polo'));
insert into public.prep_message_templates (kind, body) values
  ('polo', 'Congratulations {first_name} on your {belt}! Order your AMA black belt polo with your name on the back here: {link} - AMA Marrickville')
on conflict (kind) do nothing;
