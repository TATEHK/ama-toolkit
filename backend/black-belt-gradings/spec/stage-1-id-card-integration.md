# Stage 1: Existing ID Card Software

Inspection of [theggatonklenner/ama-id-cards](https://github.com/theggatonklenner/ama-id-cards) (commit `81bdddc`) to decide how the Black Belt Prep System should connect to it. Nothing in the card software has been changed.

## What it is

| Question (spec section 11) | Finding |
|---|---|
| Platform | Static web app (`docs/index.html`, installable on phones) hosted on GitHub Pages, plus a Node.js print agent on the Windows laptop attached to the PPC ID 4000 |
| Where student data lives | Supabase (hosted Postgres) behind a login. Photos, signature and print files in a private Supabase storage bucket |
| Fields used for cards | `name`, `dob`, `dan`, `issued`, `photo_path` |
| Google Sheets connection | None |
| API or database access | Yes. Supabase exposes every table through its REST API, protected by login and row-level security |
| Print status | `print_jobs` table (pending, approved, printing, printed, failed, cancelled) and `people.printed_at`, which clears automatically when card details change |
| Scope | Dan certificate ID cards only (1st to 9th Dan) |

## Data structure

**people**: `id` (uuid), `name`, `dob`, `dan`, `issued`, `photo_path`, `printed_at`, `created_at`, `updated_at`

**print_jobs**: `id`, `created_by_email`, `people_ids[]`, `people_names[]`, `card_count`, `sides`, `pdf_path`, `status`, `approved_by_email`, `approved_at`, `printed_at`, `error`

**Also**: `settings` (card text and artwork), `print_station` (laptop heartbeat), `staff_roles` (admin, approver, photos, viewer, printer, pending), `push_subscriptions`

**Existing import and export**
- Export people list as CSV: Name, Date of birth, Dan, Issued, Photo (Yes/No)
- Paste rows from the member system (FirstName, MiddleName, LastName, DOB, Dan). Duplicates are skipped by name
- Full JSON backup and restore (admin only), also matched by name

## Mapping to the spec's ID card fields

| Spec field or status | Card software today |
|---|---|
| Student ID | **Missing.** People have an internal uuid only; matching is by name |
| Card type | Not stored. All cards are dan certificate cards |
| Details verification / "Details incomplete" | Derivable: missing photo or date of birth |
| Required | Person exists and `printed_at` is empty |
| Ready for printing | Required, with photo and details complete |
| Sent for printing | Person is on a job that is pending, approved or printing |
| Printed / date printed | `printed_at`, plus the job's `printed_at` |
| Awaiting collection, Issued or collected | **Not tracked** |
| Reprint required | Implied when `printed_at` is cleared after a details change. No reprint reason recorded |
| Print history (each event kept) | Already exists: every `print_jobs` row is kept with the people on it |

## Key findings

1. **No shared identifier.** Matching on name alone will break on name changes, spelling differences and two members with the same name. A permanent Student ID needs to exist on both sides.
2. **Print history should not be duplicated.** `print_jobs` already keeps every print event. The prep system should read it rather than keep its own copy.
3. **Collection and reprint reasons are the only real gaps** in card tracking.
4. **The card software is on Supabase, not Google Sheets.** AppSheet cannot read it without either a sync step or a direct database connection, which depends on the AppSheet plan.

## Source of truth

| Data | Owned by |
|---|---|
| Student register, attendance, readiness, payments, grading, certificates | Black Belt Prep System |
| Photo, card name, card dan, issued date, card artwork, print approval, print status | ID card software |
| Student ID | Black Belt Prep System, copied to the card software |
| Collection status | To be decided (see options) |

## Integration options

**A. CSV handoff (no changes to the card software)**
Export students who passed grading from the prep system and paste them into the card software's existing "Paste from member system" box. Bring card status back by importing its CSV export.
Simple and safe, but manual, matched by name, and the CSV export does not include print status.

**B. Scheduled sync through the Supabase API (recommended if staying on AppSheet)**
A Google Apps Script, run on a timer with its own card-software login (viewer role to read, approver role to write):
- reads `people` and `print_jobs` into read-only Sheets tabs for AppSheet
- adds newly passed students to `people`, including their Student ID

Requires one small, additive change to the card software: a nullable, unique `student_id` column on `people`. Existing records, designs and print history are untouched. Collection status would live in the prep system.

**C. Build the prep system on the same Supabase project**
One database, one set of logins and roles, live updates, and no sync to maintain. This departs from the spec's AppSheet and Google Sheets preference, so it is a decision for you rather than a default.

## Decisions needed before Stage 2

1. Option A, B or C
2. Approval to add `student_id` to the card software's `people` table (needed for B and C)
3. Whether collection status lives in the card software or the prep system
4. Whether the AppSheet account plan supports database connections (affects B only)
