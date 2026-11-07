# Stage 7: Certificates

No database update is needed; this uses `prep_certificates` from `prep-setup.sql`.

## Certificates screen (More > Certificates; certificates role and admins can change, everyone else can view)

- Choose a cycle. Everyone put forward for grading appears, with their result.
- Totals: awaiting approval or checks, approved or ready to produce, printed but not issued, issued, reprints.
- Filters: To do (passed and not yet issued, including reprints), Awaiting result, Issued, All.
- Tap a student to set:
  - **Name on certificate**: filled in from the student's certificate name (or full name); change it to the exact wording needed.
  - **Certificate type**: Dan certificate, or Level certificate for level gradings; can be changed.
  - **Awarded rank**: the belt they graded to.
  - **Certificate number**: filled in with their Dan number if they have one; each number can only be used once.
  - **Issue date**: filled in automatically when marked Issued.
  - **Status**: Awaiting approval, Details to be checked, Approved for issue, Ready for production, Printed, Issued, Reprint required, Not required.
  - **Save as next step** moves it along in one tap.
- A certificate can only be approved, produced, printed or issued once a **pass** is recorded on the Grading screen. Unsuccessful and deferred students show as Not required.
- **Select** several to set their status together; anyone without a pass is skipped for approval and later steps.
- The dashboard shows a certificate summary once someone in the active cycle has passed.

## Certificate list

From the Certificates screen, **Certificate list**. It has its own templates, separate from grading lists:
- Ready-made: Awaiting approval, Ready for production, Printed, Issued, Reprints, All passed.
- Filters: certificate status, grading result, awarded rank.
- Columns: Student ID, certificate name, full name, certificate type, awarded rank, certificate number, Dan number, previous belt, grading date, grading result, issue date, certificate status, notes. Tick to add or remove, ↑ ↓ to reorder.
- Preview, **Download CSV**, **Print**, **Save template**.

## For the printing company

The certificate list opens on **For the printing company**: Name, Belt (the belt they graded for), Date (the grading date, written out) and Dan number, for everyone with a pass. Excel and CSV start straight with the column headings, so the file can go to the printer as it is.

Under **Headings and format** you can:
- Rename any column heading (e.g. "Belt" to "Belt applying for").
- Choose the date format: 14 Nov 2026, 14 November 2026, 14th November 2026, 14/11/2026 or 2026-11-14.
- Turn the title rows at the top of Excel and CSV files on or off.

Use **Columns** to add or reorder fields (e.g. certificate number or certificate type), then **Save template** to keep the layout. Headings and format are saved with the template. These options work on every list and report.

The grading list and certificate list now share the same list builder, so they work the same way.
