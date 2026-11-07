# Stage 2: Database

## Platform decision

The prep system is built in the **same Supabase project as the AMA ID Cards software** (option C in the Stage 1 findings), instead of Google AppSheet and Google Sheets.

Why: one database, one set of logins, live updates between devices, and no sync to maintain between the prep system and the card software. Spec section 17 allows a different platform where it gives a more reliable result.

What changes from the spec:
- Tables are Postgres tables (prefixed `prep_`) rather than Google Sheets tabs.
- The app will be a web app like the card software, installable on phones.
- Google Sheets stays available as an export format (CSV opens directly in Sheets).

## Running it

1. In Supabase, open **SQL Editor > New query**.
2. Paste all of `supabase/prep-setup.sql` and click **Run**.

It must run after the card software's `setup.sql`, `roles.sql` and `printed.sql`, which are already in place. It is safe to run again.

**The one change to the card software:** an optional `student_id` column on its `people` table. Existing people, card designs and print history are not touched, and the card software keeps working as before (tested).

## Tables

| Spec tab | Table | Notes |
|---|---|---|
| Students | `prep_students` | Student ID like `BB0001`, permanent. `is_test` marks test records |
| PreparationCycles | `prep_cycles` | Per-session and upfront fees per cycle (no payment due date since update 07) |
| Sessions | `prep_sessions` | Four per cycle by default |
| (new) | `prep_enrolments` | Who is taking part in each cycle |
| Attendance | `prep_attendance` | One row per student per session, starts as "not recorded" |
| ReadinessRecords | `prep_readiness`, `prep_readiness_history` | Current status per cycle, plus every change |
| Payments | `prep_payments` | Fee per student per cycle |
| PaymentTransactions | `prep_payment_transactions` | Locked once entered; mistakes fixed with a correction |
| GradingRecords | `prep_grading` | Eligibility decision snapshots attendance and readiness at the time |
| CertificateRecords | `prep_certificates` | Cannot be approved or issued without a pass |
| IDCards | `prep_id_cards` + card software `people` | Collection tracked here; card details stay in the card software |
| IDCardPrintHistory | card software `print_jobs` + `prep_print_event_notes` | Read from the card software, not copied; reprint reasons added here |
| ReportTemplates | `prep_report_templates` | Instructor or admin audience |
| Settings | `prep_settings` | Sessions required, excused counting, multiple active cycles, per-session and upfront fee defaults |
| AuditLog | `prep_audit_log` | Every change, who made it and when |

## Calculations

| View | What it gives |
|---|---|
| `prep_attendance_summary` | Attended, absences, excused, unrecorded, percentage, whether the attendance requirement is met |
| `prep_payment_summary` | Total paid, balance, payment status |
| `prep_id_card_status` | Card status from the card software plus collection |
| `prep_overview` | One row per student per cycle with every status; used by the dashboard and follow-up list |
| `prep_possible_duplicates` | Students whose names match ignoring case, spacing and punctuation |

**Attendance percentage** = present / (present + absent). Excused and not-yet-recorded sessions are left out.
**Attendance requirement** = present sessions (plus excused, if turned on in Settings) at least the number required (default 4).

**Payment status** is worked out in this order, unless an admin has set it by hand with a reason:
refunded, paid, not invoiced, overdue, partially paid, due.

**ID card status:** not required, required (not yet in the card software), sent for printing, reprint required, details incomplete, ready for printing, collected, awaiting collection, printed.

## Actions

| Function | What it does |
|---|---|
| `prep_start_new_cycle` | Creates a planned cycle, its sessions and fresh attendance, readiness and fee records. Blocked if the name already exists |
| `prep_activate_cycle` | Activates a cycle; optionally completes the current one |
| `prep_mark_attendance` | Marks the listed students only. Nobody else is marked absent |
| `prep_send_to_card_software` | Adds a passed student to the card software, or links them to an existing card record without overwriting it |

## Roles

| Role | Can do |
|---|---|
| admin | Everything |
| instructor | Attendance and readiness |
| attendance | Attendance only |
| payments | See and record fees and payments (no one else can see money) |
| grading | Grading records and results |
| certificates | Certificate records |
| idcards | ID card tracking and sending students to the card software |
| viewer | Look only, without payment details |

Card software admins become prep admins on the first run. A person can hold several roles. Logins are shared with the card software; prep roles are separate from card roles.

## Tests

`tests/database.test.mjs` builds the card software's database, adds the prep system and runs 88 checks covering the database parts of spec section 16, including:

- duplicate prevention for students, attendance, cycles and receipts
- bulk attendance never marking others absent
- correct percentages with unrecorded sessions
- new cycles leaving earlier records untouched
- readiness, payment and grading staying independent
- locked payment transactions and corrections
- certificates requiring a pass
- the full ID card flow, including reprints keeping the original print event
- permissions for every role, including payment information being hidden

To run: see the Tests section of [stage-3-app.md](stage-3-app.md).
