-- Push a phone notification when a Black Belt Club invitation card is newly needed.
-- Fires when efc_members.bbc_invited_at goes from empty to set (a teacher taps "Invite to Black Belt Club").
-- Reuses the ID Cards push system: push_notify -> the "notify" Edge Function (kind 'bbc_card') -> subscribed phones.
-- Best-effort: a notification problem never blocks the invite. Safe to run again.

create or replace function public.notify_bbc_card() returns trigger
  language plpgsql security definer set search_path = public, extensions
as $$
begin
  if new.bbc_invited_at is not null and old.bbc_invited_at is null then
    begin
      perform public.push_notify('bbc_card', jsonb_build_object('name', new.full_name, 'member', new.member_key));
    exception when others then null;
    end;
  end if;
  return new;
end $$;

drop trigger if exists efc_members_bbc_card_notify on public.efc_members;
create trigger efc_members_bbc_card_notify
  after update of bbc_invited_at on public.efc_members
  for each row execute function public.notify_bbc_card();
