# Stage 8: ID cards linked to the card software

Run `supabase/prep-update-06.sql` once in Supabase > SQL Editor (after update 05).

## Who gets an ID card

Only students going for 1st Dan or higher: those on Probationary Black Belt, 1st Dan Level 1, 2nd Dan Level 2, 3rd Dan Level 3 or 4th Dan Level 4. Cho Dan Bo students (going for Probationary Black Belt) get a Dan number but no ID card. Card status, the Link card button and the ID cards report only appear for them. Other students show no card information, even if a card with their name exists in the card software.

## How cards are linked

Card records in AMA ID Cards are linked to prep students by name, ignoring capitals, spaces and punctuation:
- Existing cards are linked when the update is run.
- A card added in the card software links itself to the matching student.
- A student added here links to an existing matching card.
- A card is linked only when its name matches exactly one student (and that student has no other card), so a card never attaches to the wrong person. Two students with the same name are left for linking by hand.

Linking only fills in the Student ID on the card record; nothing else in the card software changes, and it keeps working as before.

**Linking by hand:** on a student's record, **ID card > Link card** (admins and the ID cards role) lists unlinked cards to choose from, e.g. when the card has a middle name. **Change** or **Unlink card** fixes a wrong link.

## Card status shown in the prep app

Read live from the card software's print records:
- **ID card printed** (with the date): the card has been printed.
- **Card in print queue**: sent for printing, waiting for approval or the printer.
- **Card reprint needed**: printed before, but its details changed since (e.g. a new dan), so the card software has marked it to print again.
- **Card not printed yet**: linked but never printed.

Where it shows:
- **Attendance** (the session list), under each student's name.
- **Students** list: a "Card" tag for students whose card is printed.
- **Student record**: the card status and print date.

## ID card filter

The **Students** and **Attendance** screens have an ID card filter:
- **No ID card printed**: students going for 1st Dan or higher whose card hasn't been printed (no card linked, not printed yet, in the print queue, or reprint needed).
- **ID card printed**.

The **ID cards** report has the same option, and a ready-made "No ID card printed" list to export.

Changes in the card software show here when the app is reopened or refreshed (and straight away for people who also have a card software role).
