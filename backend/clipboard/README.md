# Clipboard

Text templates you can copy with one tap: https://theggatonklenner.github.io/clipboard/

- Tap a template (or **Copy**) and it's on your clipboard, ready to paste.
- Put blanks in braces, like `{Name}` or `{Amount}`, and you're asked for them when copying (with a preview). `{date}`, `{day}` and `{time}` fill themselves in.
- Pin favourites to the top, sort by most used, A to Z or newest, search, and filter by category.
- On a computer: press `/` to search, Enter to copy the top result.
- One shared library: everyone with an AMA staff login (a permission in AMA ID Cards or a role in Black Belt Prep) sees, copies and can edit every template. Each one shows who added it and who last changed it.
- With no connection, your last saved copy still opens and copies.
- **Export** saves a backup file; **Import** adds templates from one (skipping ones you already have).
- Add it to your phone's home screen (Share > Add to Home Screen) to use it like an app.

## Setup (once)

1. In Supabase, open **SQL Editor > New query**, paste the whole of `supabase/clipboard-setup.sql`, and click **Run** (choose "with RLS" if asked).
2. On GitHub, open this repository's **Settings > Pages**, choose **Deploy from a branch**, branch **main**, folder **/(root)**, and save.

## Tests

`node tests/clipboard.test.mjs` checks the database rules and the site in a browser. It uses the test tools from the black-belt-prep-system repository (see the top of the file).
