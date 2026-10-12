# tests/legal-dates-move-with-the-words.law.test.tsx

Walking the app for store review on 2026-09-29 found every legal date stale.
The Terms page and the in-app acceptance modal both said January 2026, three
weeks after the chip wording in both changed on 2026-09-08; the Privacy Policy
said January 29 after a whole "Third-Party Services" section was added on
2026-09-08 and Sentry was taken out of it on 2026-09-16. Nothing noticed,
because nothing connected the words to the date: they lived in three files,
the modal had its own hand-typed copy, and a reviewer reading a diff of the
text has no reason to look at a date prop two hundred lines away. A date on a
legal document that does not move with its text is a false statement to every
player who reads it and to every store reviewer who checks it. So the dates
now live in one module, `src/components/legal/legalDates.ts`, the pages and
the modal read them from there, and this law fingerprints each document's
RENDERED words (so a formatting re-wrap is not a change) beside the date it
carries. Change the words and the law fails until the date is moved to the
day the change ships and the fingerprint is re-recorded, in the same commit.
The wording itself stays Dan's (CLAUDE.md 10.9); the date is only the truth
about when it last changed.
