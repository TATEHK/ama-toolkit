# Black Belt Preparation Management System

A mobile-friendly system for managing Taekwondo black belt preparation cycles, built on Supabase alongside the AMA ID Cards software, sharing its logins and database. It covers the student register, four-session attendance, readiness, session payments, grading, certificates and ID card printing in one place.

## Core principle

Attendance, readiness, payment, grading eligibility, grading result, certificate status and ID card status are tracked separately. No status is set automatically from another; an authorised person makes the final decision. Starting a new preparation cycle never overwrites historical records.

## Folders

- `docs/` the app (published with GitHub Pages, see [spec/stage-3-app.md](spec/stage-3-app.md))
- `supabase/prep-setup.sql` the database, then `supabase/prep-update-01.sql` (Dan numbers, sign-off, grading date, upfront or per-session fees) `supabase/prep-update-02.sql` (Dan numbers per rank) `supabase/prep-update-03.sql` (paid at each session) `supabase/prep-update-04.sql` (grading fees) `supabase/prep-update-05.sql` (deleting students, upfront payments at sessions) `supabase/prep-update-06.sql` (linking ID cards) `supabase/prep-update-07.sql` (no due date for session fees, belts up to 9th Dan) `supabase/prep-update-08.sql` (delete students anyway), `supabase/prep-update-09.sql` (classes attended) and `supabase/prep-update-10.sql` (essays) `supabase/prep-update-11.sql` (texts through GoHighLevel) and `supabase/prep-update-12.sql` (readiness reason: more time at current belt)
- `docs/essay/` the essay page students open from their personal link (no login)
- `spec/` the specification and stage notes
- `tests/` database and browser tests

## Specification

The full build specification is in [spec/specification.md](spec/specification.md).

Progress:
- Stage 1, existing ID card software: [spec/stage-1-id-card-integration.md](spec/stage-1-id-card-integration.md)
- Stage 2, database (and why it moved from AppSheet to Supabase): [spec/stage-2-database.md](spec/stage-2-database.md)
- Stage 3, student register, cycles and attendance screens: [spec/stage-3-app.md](spec/stage-3-app.md)
- Stage 4, readiness and payments screens: [spec/stage-4-readiness-payments.md](spec/stage-4-readiness-payments.md)
- Stage 6, grading and grading lists: [spec/stage-6-grading.md](spec/stage-6-grading.md)
- Stage 7, certificates and certificate lists: [spec/stage-7-certificates.md](spec/stage-7-certificates.md)
- Stage 8, ID cards linked to the card software: [spec/stage-8-id-cards.md](spec/stage-8-id-cards.md)
- Stage 9, reports and exports: [spec/stage-9-reports.md](spec/stage-9-reports.md)

| # | Section |
|---|---|
| 1 | Project overview |
| 2 | Main navigation |
| 3 | Central student register |
| 4 | Preparation cycle management |
| 5 | Attendance management |
| 6 | Student readiness tracking |
| 7 | Payment management |
| 8 | Main dashboard |
| 9 | Grading management |
| 10 | Certificate management |
| 11 | Integration with existing ID card software |
| 12 | Reports and exports |
| 13 | Google Sheets database structure |
| 14 | Automation and notifications |
| 15 | Security and user permissions |
| 16 | Build and testing requirements |
| 17 | Final deliverable |

## Build stages

1. Inspect the existing ID card software and its integration options (done)
2. Design the database tables and map existing student records (done)
3. Student register, preparation cycles, individual and bulk attendance (done)
4. Readiness tracking and payment management (done)
5. Dashboard, summary cards, filters and follow-up lists
6. Grading management and grading list generator (done)
7. Certificate management and certificate list generator (done)
8. ID card records, printing statuses and print history (done)
9. Reports, exports, permissions and automation (done)
10. Full test with sample data before using real student records

## Data and privacy

This repository holds the app, specification and build files only; member data lives in Supabase behind a login. Never commit real student details, payment records or exported reports. Card numbers and banking credentials are never stored anywhere in the system.

## Essays

Students going for a Dan (1st Dan and up) hand in an essay; Probationary Black Belt has none. Set each Dan's question (and an optional minimum word count) in More > Settings > Essay questions, and the due date on the cycle. More > Essays lists everyone who needs one: tap a student for their personal link (Copy message, Copy link, Share, or New link to stop the old one working), or Copy all links for the whole cycle. The link opens `docs/essay/`, where they type or paste the essay and/or upload a file (PDF, Word or a photo, up to 10 MB). Admins and instructors read it there, open the file, and either Mark as reviewed (with an optional mark) or Send back for changes with feedback, which the student sees on their link before handing it in again. Earlier versions are kept. Files are in a private storage bucket (`prep-essays`) that only admins and instructors can open.

## Texts through GoHighLevel

Staff text families from Black Belt Prep: **grading invitations** (with the cycle's booking and payment link), **congratulations** for passes, **not ready yet** messages, and **essay links**. Nothing is sent automatically: on the Grading screen, **Text families** picks the message, shows who it's for (ticking those with a mobile who haven't had it yet), a preview for the first student, and lets you change the wording before **Send**. Essay links are texted from a student's essay. Every text is logged; anyone already texted shows "Texted" with the date.

- Family **mobile** and **email** are on each student (Edit, or a Mobile / Email column in Import students, which also fills them in for students already in the register).
- The usual wording for each text is in More > Settings > Text messages (admins), with {first_name} {name} {belt} {current_belt} {grading_date} {link} {reason}.
- The booking and payment link for invitations is on the cycle (**Grading invitation link**).
- Who can send: invitations and congratulations, the Grading role; not ready yet, Instructor or Grading; essay links, Instructor (admins can send all).

Setup (once):
1. Run `supabase/prep-update-11.sql` (and 12) in Supabase > SQL Editor.
2. In GoHighLevel (the sub-account): Settings > **Private Integrations** > Create new integration, name it "Black Belt Prep", and give it access to **View Contacts, Edit Contacts** and **View/Edit Conversation Messages** (conversations/message.write). Copy the token. The location ID is in Settings > Business Profile (also in the address bar after /location/).
3. In Supabase: Edge Functions > Secrets: add `GHL_TOKEN` (the token) and `GHL_LOCATION_ID`. Optionally `GHL_TEST` = `1` to try it out: texts are logged but not sent.
4. Edge Functions > Deploy a new function > Via Editor: name it `ghl`, paste the whole of `supabase/functions/ghl/index.ts`, Deploy, then turn off "Verify JWT" for it.
5. In Black Belt Prep, More > Settings > Text messages > **Check the GoHighLevel link**.

Each family is found in GoHighLevel by mobile (then email); if they're not there yet they're added as a contact (tag "ama black belt prep"). Texts go out from the sub-account's usual number and show in GoHighLevel Conversations, where replies arrive too.

## EFC Aquila contacts (through Zapier)

EFC's Zapier app has no "find member" search, so Zapier sends members in and Supabase keeps a searchable copy (table `efc_members`: names, mobile, email, parent details). Admins, instructors and grading staff can read it (`efc_search('part of a name')`).

- `supabase/prep-update-13.sql` makes the table, the search, and the webhook secret (table `efc_hook`).
- `supabase/functions/efc/index.ts` is the webhook (deploy as `efc`, "Verify JWT" off; the secret in the address is the check).
- Zap: EFC Aquila trigger (New Member, New Lead, Member Query), then Webhooks by Zapier > POST to `https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/efc?key=<secret from efc_hook>` (add `&kind=lead` for leads), payload type json, Data left empty so every EFC field is sent. Field names are matched loosely (First Name, Mobile, Guardian Email and similar); anything else is kept in `raw`.
- Zapier only sends members added after the Zap is turned on, so load existing members once from an Aquila export.
- `supabase/prep-update-14.sql` links students to EFC. Each student has an EFC ref (EFC member number) and a parent or guardian name. A student links by themselves when exactly one EFC member has the same name (ignoring capitals and punctuation); blank mobile, email and parent name are then filled from EFC, and nothing typed in is overwritten. Linked students show an EFC badge (EFC? means the ref isn't in the EFC copy). Admins link the rest from the student record with Find in EFC. After loading new EFC data, run `select prep_efc_link();` (as an admin) to link and fill again.

### Polo shirts (prep-update-15 and 16)

- `supabase/prep-update-15.sql` and `prep-update-16.sql` add the black belt polo (More > Polo shirts, for admins, grading and payments staff).
- Each year has its own shirt. The back has the names of everyone who passed Probationary Black Belt or a Dan that year (the names list downloads as a CSV for the printer), and each of them can order one.
- Grading staff choose the year, press **Make links for all** (or **Add someone else**) and **Text links**. Each family's link (`polo/#t=...`) only asks for the size and how many, then they pay by card on Stripe's page. The `polo` function marks the order paid with the size straight away.
- Staff see who has paid and the sizes to order, download the supplier list (student, size, quantity), then mark orders ordered and handed out. Payments staff can also record a polo paid by cash, EFTPOS or transfer. Only Stripe or payments staff can mark a polo paid.
- Admins set the price, sizes, whether orders are open and the text wording (Polo shirts > Settings).
- Stripe setup (once):
  1. In Stripe, Developers > API keys: copy the Secret key. In Supabase, Edge Functions > Secrets, add `STRIPE_SECRET_KEY`.
  2. Stripe > Developers > Webhooks > Add endpoint: `https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/polo`, events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy its Signing secret and add it as `STRIPE_WEBHOOK_SECRET`.
  3. Try it with a test key (`sk_test_...`) and Stripe's test card 4242 4242 4242 4242 first, then swap in the live key.

