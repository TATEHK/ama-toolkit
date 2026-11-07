# AMA Toolkit

Every AMA web app, published at **https://app.train-ama.com** by Cloudflare.

## Layout

- `site/` is the website, exactly as it is published. Edit pages here.
  - `/` Toolkit home, `/grading/` grading hub, `/grading/coloured-belts/` coloured belts
  - `/Black-belt-prep-system/` Black Belt Gradings (staff), with `/polo/` and `/essay/`
  - `/ama-id-cards/` ID Cards, `/clipboard/` Clipboard, `/staff/` staff logins
  - `/tv/` TV display, `/awards/`, `/memories/`, `/welcome/`, `/sso/`, `/halloween/`
  - `/b` grading enrolment and payment links, `/p` grading photos, `/e/` essays
- `backend/<app>/` holds each app's Supabase SQL, Edge Functions, tests and tools. Nothing here is published.
- `wrangler.jsonc` tells Cloudflare to publish `site/` as the Worker `ama-site`.

## Publishing

Cloudflare (Workers & Pages > ama-site > Settings > Build) is connected to this repo:
every push to `main` publishes `site/`. No build command is needed.

To publish by hand instead, zip the contents of `site/` and upload it as a new deployment of `ama-site`.

## Rules for the site folder

- Keep paths and capitals the same: links already sent to families use them.
- Never put server code (`.ts`), secrets or `supabase/` folders in `site/`.

## Tests

Each app's tests are in `backend/<app>/tests`. Run `npm install` there first.
