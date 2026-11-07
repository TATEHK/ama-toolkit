# Stage 4: Readiness and payments

No database update is needed for this stage; it uses the tables from `prep-setup.sql` and updates 01 to 05.

## Navigation

The phone tab bar has room for five tabs: **Dashboard, Students, Attendance, Readiness, More**.
**Preparation cycles** and **Payments** are in **More**. The dashboard links straight to readiness lists and payments.

## Readiness tab (instructors and admins; everyone else can view)

- Choose a cycle; filter by status (Not assessed, On track, Needs preparation, Not ready, Ready, Awaiting review), belt or name.
- Tap a student to set their status, reason, instructor notes and recommended next action.
- **Needs more preparation** and **Not ready for grading** require a reason: technique, fitness or conditioning, attendance concerns, additional practice, instructor recommendation, or other.
- Every change is kept; the student's readiness record shows the history with who changed it and when.
- **Select** several students to set their readiness together. Blank notes and next action keep what each student already has.
- Readiness is separate from attendance, payment and grading. Nothing is set automatically.
- The student record shows readiness with an Update button.

## Payments (More > Payments; admins and the payments role)

- Choose a cycle and show all fees, session fees or grading fees.
- Totals: outstanding, received, overdue (only grading fees can be overdue; session fees have no due date).
- Filters: owing, overdue, part paid, paid, other (waived, refunds, nothing owed yet), all.
- Tap a fee to see what's owed, paid, the balance, due date and every transaction, and to:
  - **Record payment** (amount, date, method, receipt or reference). A receipt number can't be used twice for the same fee.
  - **Refund** or **Correction** (each needs a note). Transactions are never edited or deleted.
  - **Switch** a student between per session and upfront.
  - Set a **one-off fee** (e.g. a discount) with a reason.
  - **Waive** or set the status by hand with a reason, and go back to automatic.
- This is a register of payments made outside the app. No card or bank details are stored.

## Dashboard

- Readiness: ready, need more preparation, not ready, awaiting assessment or review. Each opens the Readiness tab filtered to that group.
- Payments (admins and payments role): outstanding total, session fees owing, overdue, fully paid. Each opens Payments filtered.
- Needs attention now also lists students not ready or needing preparation (with the reason), and overdue session and grading fees. Tapping one opens their readiness or payment record.

## Tests

`tests/app.test.mjs` now covers 136 checks, including readiness reasons, history and bulk updates, the payments screen (one-off fee, payment, duplicate receipt, refund, waiver, grading fees view), dashboard summaries and read-only access for other roles.
