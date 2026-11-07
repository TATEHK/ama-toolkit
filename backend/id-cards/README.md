# AMA ID Cards

Card maker and print queue for Australian Martial Arts Academy dan certificate ID cards.

- `docs/` is the website (published with GitHub Pages)
- `print-station/` runs on the Windows laptop connected to the PPC ID 4000
- `supabase/setup.sql` creates the database
- See `SETUP.md` for the full setup guide

Member data is stored in Supabase behind a login, not in this repository.

## Tests

`tests/` has checks for user permissions: `node tests/permissions.test.mjs` (database rules) and `node tests/users.test.mjs` (the Users screen in a browser). They use the test tools from the Black Belt Prep repository; see the top of each file.
