# Leaving a club says what it costs (2026-10-06)

## What was wrong

"Leave Club" moves every chip the member holds in that club to the club
treasury and deletes the membership (`fn_member_leave_to_treasury`). The
confirmation read "Are You Sure You Want To Leave <Club>? This Action Cannot
Be Undone." No balance, no mention of chips: a long-press and two taps gave a
player's whole club balance away without a word.

The same function never looked at the felt. A member holding a live seat
funded from the club could leave it, and the stack on the table then had no
member wallet to be cashed out into.

## The fix, at the cause

- The confirmation reads the member's own balance when it opens and prints it:
  "You Hold 1,234.50 Chips Here. They Go Back To The Club And Cannot Be
  Recovered." The Leave plate waits for that read. A balance that could not be
  read is never shown as zero; the copy then says any chips held go back to
  the club. (`src/utils/leaveClubWarning.ts`, `src/pages/HomePage.tsx`.)
- Migration `20261006024809`: the function refuses, for every caller, while
  `table_seats` holds a live seat (`left_at IS NULL`) for that member funded
  from that club: "Leave Your Seat At The Table First". Read on production
  before writing it: 1,314 live seats, every one with `club_id` set and a
  matching membership, so `table_seats.club_id` is the funding club.

The rule that a departing member's chips return to the club is unchanged.

## Proof

Scratch PostgreSQL 16 holding the installed definition (md5
`0fb993c0459d542d262d7fa8a8e857db`): with a live seat the leave returns the
refusal and the membership and its 50 chips are untouched; once the seat has
`left_at`, the leave succeeds and the treasury goes from 10 to 60. Applying
the migration twice is a no-op.

Pinned by `tests/a-seated-member-leaves-the-table-before-the-club.law.test.ts`
and `tests/unit/leaveClubWarning.test.ts`.
