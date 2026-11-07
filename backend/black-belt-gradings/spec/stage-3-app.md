# Stage 3: Student register, cycles and attendance

The app is a single web page (`docs/index.html`) published with GitHub Pages, in the same style as AMA ID Cards. It installs on a phone like an app (Share > Add to Home Screen) and uses the same logins.

## Publishing

1. On GitHub, open this repository's **Settings > Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, branch **main**, folder **/docs**, then **Save**.
3. After a minute the app is at `https://theggatonklenner.github.io/Black-belt-prep-system/`.

GitHub Pages on a free account needs the repository to be public. That is safe here: the code holds no member data or passwords, and the database only answers signed-in users with a prep role.

## Database update 01

Run `supabase/prep-update-01.sql` once in Supabase > SQL Editor (after `prep-setup.sql`). It adds:
- **Dan numbers.** Students going for Probationary Black Belt or a Dan get the next number when they join a cycle. Set the next number under More > Settings. Numbers go up by one per person in name order, are never reused, and a student repeating the same grading keeps theirs. An admin can correct a number from the student record (with a reason).
  Cho Dan Bo > Probationary Black Belt, Probationary Black Belt > 1st Dan Black Belt, 1st Dan Level 1 > 2nd Dan, 2nd Dan Level 2 > 3rd Dan, 3rd Dan Level 3 > 4th Dan, 4th Dan Level 4 > 5th Dan.
- **Sign-off.** The last session of every cycle is the sign-off. A student only meets the attendance requirement if they are marked Present at it; excused does not count.
- **Grading date** for each cycle.
- **Fees: $200 upfront or $60 per session.** Both are set per cycle (defaults in Settings). Students start on per session (since update 03); anyone with the Payments role can switch a student on their record. Per-session students owe the fee for each session they are marked Present at, so the amount updates as attendance is recorded or corrected. A one-off fee needs a reason.

The app keeps working before the update is run; Dan numbers and grading dates appear once it is.

## Database update 02

Run `supabase/prep-update-02.sql` once (after update 01). Dan numbers now run separately for each rank being graded for: Probationary Black Belt, 1st Dan, 2nd Dan, 3rd Dan, 4th Dan and 5th Dan each have their own next number under More > Settings. Numbers already handed out are kept, and each rank starts from the single next number set before (change them in Settings). The same number can be used once per rank.

## Database update 03

Run `supabase/prep-update-03.sql` once (after update 02). Per session ($60, paid at each session) becomes the normal fee option; $200 upfront is the exception, switched on the student's record. Whoever takes attendance can tap **$** next to a per-session student to record that session's payment (cash), and tap again to undo it (kept as a correction). They see only paid or not paid, never balances.

## Database update 04

Run `supabase/prep-update-04.sql` once (after update 03). Grading fees are separate from session fees:
- Set the fee for grading to each belt under More > Settings > Grading fees.
- On a cycle, tick the students who are grading. Each is charged the fee for their next belt, due 3 weeks before the cycle's grading date (it moves if the grading date moves).
- Unticking removes the fee, unless a payment has been recorded.
- The student record shows whether they're grading, to which belt, and (for admins and the payments role) the fee, with a button to record a payment. The dashboard shows how many are grading and how many grading fees are owing.

## Database update 05

Run `supabase/prep-update-05.sql` once (after update 04).
- **Delete students** added by mistake, from the student record or several at once. Students with payments, grading records or certificates are skipped and listed with the reason (deactivate them instead). Their cycle places, attendance and Dan numbers go with them; the audit log keeps a record.
- **Upfront payments at a session.** Tapping $ for an upfront student records the full upfront fee, and every session then shows as paid. Attendance is still recorded separately.

## Database update 07

Run `supabase/prep-update-07.sql` once (after update 06).
- **Session fees have no due date.** They are paid at each session (or upfront), so they never show as overdue. Unpaid session fees show as "Payment due"; a student who owes nothing yet shows "Nothing owed yet". Only grading fees have a due date (3 weeks before grading). The cycle's payment due date and the old "fees due on joining" and "default fee" settings are gone.
- **Belts up to 9th Dan.** 5th Dan Levels 1 to 5, then 6th, 7th, 8th and 9th Dan. 5th Dan Level 5 goes for 6th Dan, then 6th for 7th, 7th for 8th and 8th for 9th. Each of 6th to 9th Dan has its own Dan numbers (set the next number in Settings), an ID card and a grading fee.

## Database update 08

Run `supabase/prep-update-08.sql` once (after update 07). When deleting skips students because they have payments, grading records or certificates, an admin can tap **Delete anyway**. After a second warning, the student is deleted with all their history, including payments, so payment totals change. Every removed row is still kept in the audit log (More > Recent changes). Payment transactions still can't be deleted any other way.

## Giving people access

People sign in with their AMA ID Cards login. Card software admins are already prep admins. To add someone else: **More > Users > Add user**, enter their email and tick their roles. If they don't have a login yet, create one in Supabase first (Authentication > Users).

## What's in this stage

**Dashboard**
- Active cycle with session dates, sign-off and grading date, and a "Take attendance" shortcut for the next session
- Active students, students in the cycle, attended all sessions, with absences, attendance not recorded for past sessions, below the attendance requirement
- Missed the sign-off count
- Needs attention list (missed sign-off, unrecorded past sessions and absences), each opening the student record

**Students**
- Search by name or Student ID; filter by belt rank and active or inactive; test records hidden unless asked for
- Students need only a name and belt rank (no birth date). A family mobile and email are optional, added later for texts through GoHighLevel (update 11)
- Add and edit; Student IDs are created automatically (BB0001, BB0002 ...) and never change
- Belt rank is chosen from a list in grading order: Cho Dan Bo, Probationary Black Belt, 1st Dan Black Belt, 1st Dan Level 1, 2nd Dan, 2nd Dan Levels 1 to 2, 3rd Dan, 3rd Dan Levels 1 to 3, 4th Dan, 4th Dan Levels 1 to 4, 5th Dan, 5th Dan Levels 1 to 5, 6th Dan, 7th Dan, 8th Dan, 9th Dan. Imports match belts however they are written: "First Dan", "Third Dan Level 1", "3rd dan lvl 2", "1st Dan"
- Warning before adding a name that already exists, and a banner listing possible duplicates
- Deactivate and reactivate without losing history
- **Select** several students (tap them, or Select all shown) to add them to a cycle, deactivate, reactivate or delete them
- Import from CSV or pasted spreadsheet rows, with a preview that skips existing students, repeats and unknown belts; other columns are ignored
- Student record: details, current cycle (attendance by session plus readiness, payment, grading, certificate and ID card status) and earlier cycles

**Preparation cycles**
- Start New Preparation Cycle: name, four session dates (session 1 sets the rest every two weeks; session 4 is the sign-off), grading date (two weeks after the sign-off), fees, all active students or chosen students, a review step, and the option to make it active (the previous active cycle is marked Completed; its records are kept)
- A cycle name can't be used twice, so pressing the button again can't create duplicates
- Edit session dates, grading date, fee and notes (cycles have no separate start or end date); add students mid-cycle; remove a student added by mistake (blocked once a payment is recorded)
- Make active, mark completed, archive and restore

**Attendance**
- Choose a cycle and session; one tap for Present, Absent or Excused; tap another to correct it
- Search and filter by belt rank or status
- Select several, then mark Present, Excused, Absent or Clear, always with a confirmation; "Mark shown as present" for the filtered list
- Nobody who isn't selected is ever marked absent
- **$** button to record payment at the session ($60 per session, or the full upfront fee), with a "paid" count for the session. Per-session students can prepay: tap $ before they are marked present; it shows as "prepaid" and as a credit until they attend
- **Paid $** in the selection bar to record payment for several students at once (including prepaying); anyone already paid is skipped and listed
- **Upload attendance** for a session from a CSV or pasted list. A plain list of names is enough. People in the cycle are marked present; for an admin, students not in the cycle are added to it, and names not in the register become new students (a Belt column gives them their belt). A preview shows every change before anything is saved, and nobody missing from the list is marked absent
- **Check in** (Attendance > Check in, or on the dashboard): a quick sign-in screen for the door. It opens on today's session (or the next one) with the search box ready. Type part of a name (first letters of first and last name work, e.g. "ale smi"), then tap **Paid** (checks them in and records the payment: the session fee, or the full fee for an upfront student who hasn't paid) or **Unpaid** (checks them in only). Anyone already paid for that session, or paid upfront, gets a single **Check in** button. Pressing Enter when there's one match checks them in as Unpaid. The box clears for the next person. Everyone not yet in is listed to tap without typing. The **Here** list shows who's checked in (latest first), with **$** to record their session payment and **↶** to undo a check-in. Admins can also add someone who isn't in the cycle and check them in. For admins and the Payments role, anyone with unpaid fees shows a red **Owes** note (e.g. "Owes $120 · sessions $60, grading $60", including earlier cycles) so you can ask on the spot; attendance-only staff never see amounts. A warning shows if the chosen session isn't today
- Summary grid for the whole cycle with attended count, percentage and whether the requirement is met

**More**
- Settings: sessions required, whether excused counts, per-session and upfront fees, grading fees, next Dan numbers, allowing more than one active cycle
- Users and roles
- Recent changes from the audit log

Changes made on one device appear on others automatically.

## Tests

`tests/app.test.mjs` runs the app in a headless browser at phone size against a local stand-in for Supabase that uses the real database rules. It covers 229 checks, including sign-in, permissions for three roles, student add/edit/duplicate/import, starting cycles, individual, bulk and imported attendance, history being preserved, and no browser errors.

```
cd tests && npm install
CARD_REPO=/path/to/ama-id-cards node database.test.mjs
CARD_REPO=/path/to/ama-id-cards node app.test.mjs
```
