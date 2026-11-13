-- prep-update-28.sql: grading helpers can help at more than one session ("1 and 3", "2 and 3", "all").
-- prep_helpers.slot_id (one session) becomes slot_ids (any number of sessions). Each session a helper is in counts
-- towards that session's cap (6) if they're going for 4th Dan and above.

alter table public.prep_helpers add column if not exists slot_ids uuid[] not null default '{}';
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'prep_helpers' and column_name = 'slot_id') then
    update public.prep_helpers set slot_ids = array[slot_id] where slot_id is not null and slot_ids = '{}';
    drop index if exists public.prep_helpers_slot_idx;
    alter table public.prep_helpers drop column slot_id;
  end if;
end $$;
create index if not exists prep_helpers_slots_idx on public.prep_helpers using gin (slot_ids);

-- Add a helper to one or more sessions. Each session is checked on its own: one with room is added, a full one is not.
-- p_balance (a text reply picking a single session): that session can't get more than 1 ahead of the emptiest one with room.
-- Returns {"ok": [slot ids added or already theirs], "full": [...], "uneven": [...]}.
drop function if exists public.prep_helper_claim(uuid, text, uuid, text, text, boolean);
drop function if exists public.prep_helper_claim(uuid, text, uuid, text, text);
create or replace function public.prep_helper_claim(p_cycle uuid, p_student text, p_slots uuid[], p_reply text default null, p_by text default 'reply', p_balance boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.prep_helper_slots; sid uuid; n int; low int; sen boolean; mine uuid[]; oks uuid[] := '{}'; fulls uuid[] := '{}'; unev uuid[] := '{}';
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and not public.prep_has_role('grading', 'calls') then raise exception 'Not allowed'; end if;
  perform 1 from public.prep_helper_slots where cycle_id = p_cycle order by slot_id for update;   -- one claim at a time per cycle
  select coalesce((select senior from public.prep_helpers where cycle_id = p_cycle and student_id = p_student), true),
         coalesce((select slot_ids from public.prep_helpers where cycle_id = p_cycle and student_id = p_student), '{}')
    into sen, mine;
  foreach sid in array (select coalesce(array_agg(distinct x), '{}') from unnest(p_slots) x) loop
    select * into s from public.prep_helper_slots where slot_id = sid and cycle_id = p_cycle;
    if not found then continue; end if;
    if sid = any(mine) then oks := oks || sid; continue; end if;
    select count(*) into n from public.prep_helpers where sid = any(slot_ids) and student_id <> p_student and senior;
    if sen and n >= s.cap then fulls := fulls || sid; continue; end if;
    if p_balance and sen and cardinality(p_slots) = 1 then
      select min(c) into low from (
        select (select count(*) from public.prep_helpers h where x.slot_id = any(h.slot_ids) and h.student_id <> p_student and h.senior) c, x.cap
        from public.prep_helper_slots x where x.cycle_id = p_cycle) t where c < cap;
      if n > coalesce(low, n) then unev := unev || sid; continue; end if;
    end if;
    mine := mine || sid; oks := oks || sid;
  end loop;
  if cardinality(oks) > 0 then
    insert into public.prep_helpers (cycle_id, student_id, slot_ids, confirmed_at, declined_at, reply_text, set_by, updated_at)
    values (p_cycle, p_student, mine, now(), null, p_reply, p_by, now())
    on conflict (cycle_id, student_id) do update set slot_ids = excluded.slot_ids, confirmed_at = now(), declined_at = null,
      reply_text = coalesce(excluded.reply_text, public.prep_helpers.reply_text), set_by = excluded.set_by, updated_at = now();
  end if;
  return jsonb_build_object('ok', to_jsonb(oks), 'full', to_jsonb(fulls), 'uneven', to_jsonb(unev));
end $$;
revoke all on function public.prep_helper_claim(uuid, text, uuid[], text, text, boolean) from public, anon;
grant execute on function public.prep_helper_claim(uuid, text, uuid[], text, text, boolean) to authenticated, service_role;

-- Helper settings: the wording of each text, edited in the Black Belt app (Grading > Helpers > Settings).
-- Fields: {first_name} {day} {sessions} (the numbered list in an invitation, or "8:00am and 3:30pm sessions" in a
-- confirmation) {reply} (how to answer) {sword} (the sword sentence, only for students going for 4th Dan) {full_note}.
create table if not exists public.prep_helper_settings (
  id            int primary key default 1 check (id = 1),
  invite_4th    text not null,
  invite_senior text not null,
  invite_other  text not null,
  confirm_text  text not null,
  updated_at    timestamptz not null default now(),
  updated_by    text
);
insert into public.prep_helper_settings (id, invite_4th, invite_senior, invite_other, confirm_text) values (1,
  E'Hi {first_name}, as part of your 4th Dan grading, we''d love your help at the black belt grading on {day} at AMA Sydenham.{sword} Which sessions can you help at?\n{sessions}\n{reply}. - AMA',
  E'Hi {first_name}, as one of our senior black belts, we''d love your help at the black belt grading on {day} at AMA Sydenham. Your experience on the floor makes a real difference to the students grading. Which sessions can you help at?\n{sessions}\n{reply}. - AMA',
  E'Hi {first_name}, we''d love your help at the black belt grading on {day} at AMA Sydenham. Helping out is a great way to give back, and seeing a grading from the other side is great experience for your own. Which sessions can you help at?\n{sessions}\n{reply}. - AMA',
  E'Thanks {first_name}! You''re helping at the {sessions} on {day} at AMA Sydenham.{full_note}{sword} See you there! - AMA')
on conflict (id) do nothing;
alter table public.prep_helper_settings enable row level security;
drop policy if exists "read" on public.prep_helper_settings;
drop policy if exists "write" on public.prep_helper_settings;
create policy "read" on public.prep_helper_settings for select to authenticated using (public.prep_can_view());
create policy "write" on public.prep_helper_settings for all to authenticated using (public.prep_has_role('grading', 'calls')) with check (public.prep_has_role('grading', 'calls'));
