-- Coloured belts 41: email the team when a family signs up for Black Belt Club on the landing page.
-- Who to email (comma/newline separated). Editable without a redeploy. Defaults to the academy office.
alter table public.cb_settings add column if not exists bbc_notify_email text not null default 'info@australianmartialarts.com.au';
