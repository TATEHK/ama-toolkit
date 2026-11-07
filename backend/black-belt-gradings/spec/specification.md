# Black Belt Preparation Management System

*Complete Application Build Specification*

## 1. Project Overview

Build a complete, professional, mobile-friendly Black Belt Preparation Management System using Google AppSheet and Google Sheets wherever practical.

The application will manage the entire Black Belt preparation process, including:

- Student registration and management
- Attendance tracking for four preparation sessions
- Creating and managing preparation cycles
- Student readiness tracking
- Session fee and payment tracking
- Grading eligibility and grading results
- Grading list generation
- Certificate management and certificate list generation
- Integration with my existing ID card software
- ID card printing, collection and reprint tracking
- Historical records and reporting
- A professional dashboard showing the current state of the preparation programme

The application must be functional, reliable, and easy to use on mobile phones, tablets, and desktop computers.

The primary goal is to have one central place where administrators can manage students and see their progress without maintaining multiple disconnected spreadsheets.

Google Sheets should be the primary data source where appropriate, with Google AppSheet providing the mobile-friendly interface, forms, actions, reports, and dashboard.

Before making changes to the existing ID card software, inspect how it was built and determine the safest integration method. Do not unnecessarily rebuild or replace it.

---

## 2. Main Navigation

Create the following main navigation sections:

1. Dashboard
2. Student Register
3. Attendance
4. Preparation Cycles
5. Readiness Tracking
6. Payment Management
7. Grading Management
8. Certificate Management
9. ID Card Management
10. Reports and Exports
11. Settings

Use a clean, professional martial arts-inspired design.

The interface must have readable tables, clear status indicators, large mobile-friendly controls, quick actions, search, filters, and simple navigation.

Organise each student record into separate sections so that attendance, readiness, payments, grading, certificates, and ID card details can be viewed without cluttering the screen.

---

## 3. Central Student Register

Create a master student register that stores each student once and links them to all other parts of the system.

Suggested fields:

- Student ID
- Full name
- Certificate name, if different
- Club or school
- Current belt rank
- Contact details, if required
- Active or inactive status
- Date added
- General administrative notes

The Student ID must be unique and permanent.

Use this identifier to connect attendance, payments, readiness, grading, certificates, and ID card records.

Do not use a student’s name as the primary key.

Provide the ability to:

- Add new students
- Edit student details
- Search and filter students
- View a student’s complete history
- Deactivate students without deleting their historical records
- Identify potential duplicate records
- Import student details from a spreadsheet or CSV file where supported

When connecting the existing ID card software, preserve its existing identifiers where possible and document any mapping required.

Avoid entering the same student details multiple times across different parts of the application.

---

## 4. Preparation Cycle Management

The system must manage recurring Black Belt preparation cycles.

Each preparation cycle normally contains four sessions.

Each cycle should include:

- Unique Cycle ID
- Cycle name
- Start date
- End date
- Session 1 date
- Session 2 date
- Session 3 date
- Session 4 date
- Session fee
- Cycle status
- Administrative notes

Suggested cycle statuses:

- Planned
- Active
- Completed
- Archived

Allow administrators to create new cycles, edit upcoming session dates, activate a cycle, complete a cycle, and access historical cycles.

Clearly identify the active cycle throughout the application.

By default, maintain one active preparation cycle at a time unless the administrator explicitly configures otherwise.

### Safe New Cycle and Reset Function

Provide a clearly labelled action called “Start New Preparation Cycle”.

When starting a new cycle:

1. Ask the administrator to enter the cycle name and dates.
2. Configure the four preparation sessions.
3. Set or confirm the session fee.
4. Create new attendance records for the new cycle.
5. Create the relevant payment and readiness records.
6. Retain all previous attendance, payment, readiness, grading, certificate, and ID card history.
7. Ask for confirmation before activating the new cycle.
8. Prevent duplicate records if the action is accidentally repeated.

Never clear or overwrite the previous cycle’s attendance.

Do not reset the student register or erase historical transactions.

Each new cycle must start with fresh attendance and cycle-specific administrative statuses while preserving historical records.

Where appropriate, allow previous readiness and payment information to be viewed for reference without automatically carrying old statuses into the new cycle.

---

## 5. Attendance Management

Track attendance across all four preparation sessions for each student in each cycle.

Create an Attendance table with:

- Attendance Record ID
- Student ID
- Cycle ID
- Session number or Session ID
- Attendance status
- Date recorded
- Recorded by, where supported
- Notes

Attendance statuses:

- Present
- Absent
- Excused
- Not yet recorded

An unrecorded session must not automatically be treated as an absence.

### Individual Attendance

Provide a mobile-friendly attendance screen where an administrator can:

1. Select the active preparation cycle.
2. Select one of the four sessions.
3. View the registered students.
4. Search or filter students.
5. Mark students Present, Absent, or Excused.
6. Save and review the attendance records.

Make attendance entry quick, with minimal taps.

Allow authorised administrators to correct attendance after it has been recorded.

Retain an audit trail of important changes where supported.

### Bulk Attendance

Provide bulk attendance options so the administrator can:

- Select multiple students and mark them present.
- Mark a group present and correct individual exceptions.
- Filter students by club or other relevant criteria.
- Import attendance lists from CSV or Google Sheets where supported.
- Review imported records before saving.
- Identify invalid or duplicate records.
- Confirm bulk changes before applying them.

Never silently mark everyone not selected as absent.

The administrator must explicitly confirm any bulk absence action.

Prevent duplicate attendance records for the same student and session.

### Automatic Attendance Calculations

For each student and preparation cycle, calculate:

- Number of sessions attended
- Number of absences
- Number of excused absences
- Number of unrecorded sessions
- Attendance percentage

Calculate attendance percentage using recorded sessions only, and make the calculation rule clear.

Allow attendance eligibility requirements to be configured in Settings.

Attendance alone must not automatically determine whether a student is ready for grading.

---

## 6. Student Readiness Tracking

Create a separate Readiness Tracking section to identify students who are not ready for grading or who need further preparation.

Readiness must be recorded against both the student and the preparation cycle.

Create a Readiness table containing:

- Readiness Record ID
- Student ID
- Cycle ID
- Readiness status
- Reason for flagging
- Instructor notes
- Recommended next action
- Date last reviewed
- Reviewed by

Suggested readiness statuses:

- Not yet assessed
- On track
- Needs more preparation
- Not ready for grading
- Ready for grading
- Awaiting instructor review

Allow authorised instructors or administrators to change readiness status from the student profile or readiness list.

Provide a quick action to flag a student as not ready and record a reason.

Possible reasons include:

- Technique requires improvement
- Fitness or conditioning
- Attendance concerns
- Additional practice required
- Instructor recommendation
- Other

Allow notes and recommended follow-up actions to be recorded.

Display readiness status prominently on the student profile and dashboard.

Provide separate lists for:

- Students ready for grading
- Students needing more preparation
- Students not ready for grading
- Students awaiting assessment
- Students requiring instructor follow-up

Readiness must remain separate from attendance, payment, grading eligibility, and grading results.

A student who attends all four sessions must not automatically be marked ready.

Preserve historical readiness records when a new cycle begins.

---

## 7. Payment Management

Create a dedicated Payment Management section to track preparation session fees.

Payment records must be linked to the student and preparation cycle.

Create a Payments table containing:

- Payment Record ID
- Student ID
- Cycle ID
- Amount due
- Amount paid
- Outstanding balance
- Payment status
- Payment date
- Payment method, if required
- Receipt or transaction reference, if required
- Administrative notes

The session fee should be configurable for each preparation cycle.

Allow different fees for different cycles if necessary.

### Payment Statuses

Include:

- Not yet invoiced
- Payment due
- Partially paid
- Paid
- Payment overdue
- Waived
- Refund pending
- Refunded

Allow administrators to record payments received outside the application.

Support full payments, partial payments, approved fee waivers, and refunds.

If a student pays in instalments, record each transaction separately.

Create a Payment Transactions table containing:

- Transaction ID
- Student ID
- Cycle ID
- Amount
- Transaction date
- Transaction type
- Payment method, if required
- Receipt or reference number
- Notes
- Recorded by, where supported

Calculate the total amount paid and outstanding balance automatically.

Do not overwrite previous payment transactions when recording a new payment.

Prevent duplicate transactions where possible and allow authorised corrections.

Payment tracking is an administrative register, not a payment gateway. Do not store credit card numbers, banking passwords, or other sensitive banking credentials.

### Payment Alerts and Lists

Provide quick access to:

- Students who have not paid
- Students whose payments are overdue
- Students who have partially paid
- Students who have fully paid
- Students with approved fee waivers
- Students with refunds pending

Clearly show the amount outstanding for each student.

Allow filtering by cycle, club, payment status, and date.

Restrict financial information to authorised users.

Payment status must be specific to the preparation cycle. A student who paid during a previous cycle must not automatically be marked paid for the new cycle.

---

## 8. Main Dashboard

Build a professional dashboard that provides a complete overview of the active preparation cycle.

The dashboard should update when the underlying records change.

### Student and Attendance Summary

Display:

- Total active students
- Students registered for the active cycle
- Students with complete attendance records
- Students who attended all four sessions
- Students with absences
- Students with incomplete attendance

### Readiness Summary

Display:

- Students marked ready for grading
- Students who are not ready
- Students needing additional preparation
- Students awaiting readiness assessment

### Payment Summary

Display:

- Students fully paid
- Students with payments outstanding
- Students who partially paid
- Students with overdue payments
- Total outstanding balance for the active cycle

### Grading and Certificate Summary

Display:

- Students eligible for grading
- Students nominated for grading
- Students awaiting grading results
- Students who passed
- Certificates awaiting approval
- Certificates ready for production
- Certificates printed
- Certificates issued

### ID Card Summary

Display:

- Students requiring ID cards
- Cards ready for printing
- Cards sent for printing
- Cards printed
- Cards awaiting collection
- Cards issued
- Reprints outstanding

### Charts and Tables

Include charts showing:

- Attendance across the four sessions
- Attendance status distribution
- Readiness status distribution
- Payment status distribution
- Grading progress
- Certificate progress
- ID card printing progress

Provide a searchable student table and a “Needs Attention” section highlighting students who require follow-up.

Each follow-up entry should show the relevant issue, such as incomplete attendance, not ready for grading, payment outstanding, missing grading result, or ID card awaiting printing.

Provide quick actions to open the corresponding record and resolve the issue.

Allow filtering by preparation cycle, club, belt rank, readiness status, payment status, grading status, certificate status, and ID card status where relevant.

Clearly label the selected cycle.

---

## 9. Grading Management

Create a dedicated Grading Management section.

Grading records must be separate from attendance and readiness records.

Create a Grading Records table containing:

- Grading Record ID
- Student ID
- Cycle ID
- Grading event
- Grading date
- Current belt rank
- Target belt rank
- Attendance eligibility
- Readiness status at review
- Administrative eligibility decision
- Grading status
- Grading result
- Notes

Suggested grading statuses:

- Not assessed
- Awaiting eligibility review
- Eligible
- Not eligible
- Nominated for grading
- Grading booked
- Grading completed
- Passed
- Unsuccessful
- Deferred

Allow authorised administrators to update grading records and record results.

Use attendance, readiness, payment, and any configured requirements as information to assist the administrator.

Do not automatically mark students eligible, ready, or passed simply because they attended all sessions or paid the fee.

Where required, allow an authorised administrator to override an eligibility recommendation and record the reason.

### Grading List Generator

Create a configurable grading list generator.

Allow administrators to:

- Select a preparation cycle or grading event.
- Filter by club, belt rank, attendance, readiness, eligibility, payment status, or grading status.
- Select which columns to include.
- Rearrange column order.
- Save reusable report templates.
- Preview the list.
- Export or print the list.

Possible grading list fields:

- Student ID
- Full name
- Club
- Current belt rank
- Target belt rank
- Session 1 attendance
- Session 2 attendance
- Session 3 attendance
- Session 4 attendance
- Total sessions attended
- Attendance percentage
- Readiness status
- Payment status
- Outstanding balance, for authorised administrative reports
- Grading eligibility
- Grading date
- Grading status
- Grading result

Allow separate templates for instructor use and administrative use so that financial information is not included in grading lists unnecessarily.

---

## 10. Certificate Management

Create a separate Certificate Management section.

Certificate records must not be automatically created as issued certificates simply because a student has attended preparation sessions or appeared on a grading list.

Create a Certificate Records table containing:

- Certificate Record ID
- Student ID
- Certificate name
- Certificate type
- Awarded belt rank or qualification
- Certificate number
- Grading event
- Grading date
- Grading result
- Certificate issue date
- Certificate status
- Notes

Suggested certificate statuses:

- Not required
- Awaiting grading result
- Awaiting approval
- Details to be checked
- Approved for issue
- Ready for production
- Printed
- Issued
- Reprint required

Allow authorised administrators to enter the exact name that should appear on the certificate.

### Certificate List Generator

Create a separate configurable certificate list generator with its own fields and saved templates.

Allow administrators to:

- Select a grading event or preparation cycle.
- Select students to include.
- Filter by grading result, award status, certificate status, club, or belt rank.
- Select and reorder columns.
- Preview the output.
- Export or print the list.

Possible certificate list fields:

- Student ID
- Certificate name
- Club
- Certificate type
- Awarded belt rank
- Certificate number
- Grading date
- Grading result
- Certificate issue date
- Certificate status

Provide separate lists for certificates awaiting approval, ready for production, printed, issued, and requiring reprints.

Keep grading list configuration completely independent from certificate list configuration.

---

## 11. Integration with Existing ID Card Software

Integrate this system with my existing ID card software.

The existing software must be inspected before making integration decisions.

Identify:

- The platform used to build the application
- Where its student information is stored
- The fields currently used for ID cards
- Whether it has a Google Sheets connection
- Whether an API or database integration is available
- How card printing and print status are currently managed

Do not assume direct integration is available without verifying the existing application.

Do not rebuild or replace the existing ID card software unnecessarily.

### Student Record Synchronisation

Use a unique Student ID or a documented identifier mapping to match student records.

Synchronise relevant fields where supported, such as:

- Student ID
- Full name
- Club
- Belt rank
- Card type
- Current card status

Determine which system is the source of truth for each field.

Prevent duplicate student records and conflicting updates.

Do not overwrite existing card designs, printing records, or student details without approval.

If direct synchronisation is unavailable, provide a controlled spreadsheet or CSV import/export process with validation and duplicate detection.

### ID Card Management

Create an ID Card Management section with fields such as:

- ID Card Record ID
- Student ID
- Card type
- Card details verification status
- Card status
- Date requested
- Date submitted for printing
- Date printed
- Date issued or collected
- Reprint required
- Reprint reason
- Administrative notes

Suggested card statuses:

- Not required
- Required
- Details incomplete
- Ready for printing
- Sent for printing
- Printed
- Awaiting collection
- Issued or collected
- Reprint required

Adapt these fields to the existing ID card software wherever possible rather than duplicating existing data unnecessarily.

### ID Card Printing History

Maintain a separate history of print events.

Record:

- Print Event ID
- Student ID
- ID Card Record ID
- Print date
- Print status
- Reprint indicator
- Reprint reason
- Notes

Each reprint must create a new print event rather than overwriting the original print record.

### ID Card Reports

Generate separate lists for:

- Students who require cards
- Cards with incomplete details
- Cards ready to print
- Cards sent for printing
- Cards printed
- Cards awaiting collection
- Cards issued or collected
- Cards requiring reprints

Allow filtering by club, belt rank, card status, printing date, and preparation cycle where relevant.

Include ID card statistics on the main dashboard.

---

## 12. Reports and Exports

Provide a dedicated Reports and Exports section.

Include reports for:

1. Full student register
2. Attendance by session
3. Attendance summary by preparation cycle
4. Individual student attendance history
5. Students not ready for grading
6. Students needing additional preparation
7. Students awaiting readiness assessment
8. Students with payments outstanding
9. Students who partially paid
10. Students with overdue payments
11. Students who fully paid
12. Combined follow-up list for readiness and payment issues
13. Grading list
14. Grading results
15. Certificate production list
16. Certificates issued
17. ID cards awaiting printing
18. ID cards printed
19. ID cards awaiting collection
20. ID card printing and reprint history

Allow report-specific field selection, filtering, column ordering, and reusable templates.

Support Google Sheets, CSV, Excel, and PDF exports where supported.

Reports should include clear titles, column headings, the relevant preparation cycle or event, and the report generation date.

Preview reports before exporting.

Avoid including unnecessary personal or financial information in reports.

---

## 13. Google Sheets Database Structure

Use structured tables with unique IDs and appropriate references.

Suggested Google Sheets tabs:

1. Students
2. PreparationCycles
3. Sessions
4. Attendance
5. ReadinessRecords
6. Payments
7. PaymentTransactions
8. GradingRecords
9. CertificateRecords
10. IDCards
11. IDCardPrintHistory
12. ReportTemplates
13. Settings
14. AuditLog

If the existing ID card software already contains equivalent tables, inspect and reuse or map them before creating new copies.

### Data Integrity Requirements

- Every student must have a unique Student ID.
- Every preparation cycle must have a unique Cycle ID.
- Each student must have no more than one attendance record for a particular session.
- Attendance must be linked to a specific session and cycle.
- Payments must be linked to a student and cycle.
- Every payment transaction must be recorded separately.
- Readiness records must preserve cycle-specific history.
- Grading and certificate records must be linked to the relevant student and event.
- ID card printing events must preserve previous print history.
- Starting a new cycle must never overwrite historical records.

Use AppSheet references, validation rules, and appropriate calculated fields.

Avoid unnecessary duplication of student information across tables.

---

## 14. Automation and Notifications

Where supported, add useful administrative automation.

Possible automations include:

- Flagging students with incomplete attendance.
- Flagging students not ready for grading.
- Identifying outstanding payments.
- Identifying overdue payments according to configured due dates.
- Identifying students awaiting readiness assessment.
- Identifying grading records awaiting results.
- Identifying certificates awaiting approval.
- Identifying ID cards awaiting printing or collection.

Provide dashboard alerts and filtered lists.

Email or push notifications may be added if supported and configured by the administrator.

Do not send payment reminders, grading notifications, or other messages automatically without an authorised workflow and appropriate recipient details.

Do not assume payment or grading status from attendance.

---

## 15. Security and User Permissions

Provide administrator access controls appropriate to the application.

Where needed, configure roles such as:

- Administrator
- Attendance recorder
- Instructor
- Grading administrator
- Certificate administrator
- ID card administrator

Allow permissions to be configured according to the capabilities of the chosen platform.

Restrict financial records and other sensitive student information to authorised users.

Require confirmation before bulk updates, destructive actions, or starting a new preparation cycle.

Use archival or soft deletion where appropriate.

Maintain an audit trail of important changes where supported.

Do not rely on hiding a screen or button as the only protection for sensitive information.

---

## 16. Build and Testing Requirements

Build the application in stages.

Stage 1: Inspect the existing ID card software and identify its data structure and integration options.

Stage 2: Design the Google Sheets data tables and map existing student records.

Stage 3: Build the student register, preparation cycles, and individual and bulk attendance workflows.

Stage 4: Build readiness tracking and payment management.

Stage 5: Build the dashboard, summary cards, filters, and follow-up lists.

Stage 6: Build grading management and the configurable grading list generator.

Stage 7: Build certificate management and the separate certificate list generator.

Stage 8: Integrate ID card records, printing statuses, and print history.

Stage 9: Build reports, exports, permissions, and supported automation.

Stage 10: Test the complete system with sample data before using real student records.

Test the following scenarios:

- Adding and editing students.
- Preventing duplicate students.
- Recording individual attendance.
- Recording bulk attendance.
- Correcting attendance.
- Creating a new preparation cycle without losing historical attendance.
- Calculating attendance correctly when sessions are unrecorded.
- Flagging students who are not ready.
- Recording full and partial payments.
- Calculating outstanding balances.
- Preventing duplicate payment transactions.
- Keeping readiness and payment status separate.
- Generating different grading and certificate lists.
- Preserving historical grading and certificate records.
- Synchronising ID card records without creating duplicates.
- Recording a reprint without overwriting the original print event.
- Exporting reports.
- Enforcing access permissions.

Clearly distinguish test records from real student records.

Do not claim that an integration or automation works unless it has been implemented and tested.

---

## 17. Final Deliverable

Deliver a working, mobile-friendly Black Belt Preparation Management System using Google AppSheet and Google Sheets wherever practical.

The finished application must include:

- A central student register
- Four-session attendance tracking
- Individual and bulk attendance entry
- Safe preparation cycle resets
- Historical attendance
- Student readiness flags
- Payment tracking and outstanding balances
- Grading management and a configurable grading list
- Certificate management and a separate configurable certificate list
- Integration with existing ID card software
- ID card printing and reprint history
- A professional dashboard
- Reports and exports
- Appropriate permissions and data validation

Prioritise reliability, minimal duplicate data entry, preservation of historical records, and ease of use.

If a feature cannot be implemented directly using the selected platform, explain the limitation and recommend a reliable alternative.

Do not build a visual mock-up that only looks functional. Implement and test the underlying data, calculations, actions, and integrations.