-- ID Cards: ask people to upload their own card photo through a private link.
-- photo_token: the code in their link. photo_sent_at: when we last asked.
-- photo_pending_*: the photo they sent, waiting for staff to approve before it goes on the card.
alter table public.people
  add column if not exists photo_token text unique,
  add column if not exists photo_sent_at timestamptz,
  add column if not exists photo_pending_path text,
  add column if not exists photo_pending_at timestamptz;
