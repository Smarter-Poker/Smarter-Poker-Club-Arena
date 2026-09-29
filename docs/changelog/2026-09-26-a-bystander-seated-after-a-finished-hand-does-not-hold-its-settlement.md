# A bystander seated after a finished hand does not hold its settlement

2026-09-26. Migration `20260926131050` (replaces `20260926091455`, see below). Law
`tests/a-bystander-seated-after-a-finished-hand-does-not-hold-its-settlement.law.test.ts`.

## What was frozen

Event 8ec7e81d ($100 Freeroll 6:00 PM, 67 entrants, all horses) has had five
of its eight tables frozen since 2026-09-18 23:08. All five belong to dead
lease generation 7c88dac4. The abandoned-generation door decides a generation
as a whole, and it refused this one with
`F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION` because of one table.

## The hand

Table c1ee060b, hand 12976717, submission 3a095f5f:

- Played 23:07:43 to 23:08:06 and retained by the original at 23:08:14.
  Eight players were dealt in. Rake 0, BBJ 0, inflow 0.
- Result: seat 7 (driftwood) +75 (14,936 to 15,011), seat 1 (piedmont) -50
  (21,095 to 21,045), seat 9 (yeti) -25 (4,005 to 3,980). The other five
  chairs are unchanged. Net 0.
- Never committed: no atomic commit, no history, no handoff, no failure row.
  Every chair still held exactly its stack before the hand.

At 23:08:36, 22 seconds after the hand was retained, a late registrant
(lubbockpreston) sat in seat 3 with a fresh 5,000-chip registration. He is in
no stack row, not in the hand row's players, and has no hole card. He was
never in the hand.

## Why it could not settle

The engine already finishes a retained hand before asking the door again:
`fn_ca_resume_hand_submission` hands it to the successor generation, which
commits it through the ordinary commit core. That handoff required the number
of live chairs (9) to equal the number of stack rows (8), to prove that no
later hand had consumed the starting state. A chair that sat down after the
hand ended consumed nothing, but it failed the count, so the handoff refused
with `HAND_SUBMISSION_HANDOFF_STATE_CHANGED` on every ask.

## The ruling

Settle the hand as played. It was played to the end, the platform holds the
exact result, and the late registrant was not in it.

## What changes

1. **The handoff leaves a bystander out of the count.** A live chair counts as
   a bystander only when all of the following hold:
   - the table belongs to a tournament;
   - it joined after the submission was retained and after the hand ended;
   - it is in no stack row, is no hand-row player, and holds no hole card;
   - it holds chips, exactly its own playing registration's chips at that
     table and seat.

   Every protection for a participant is unchanged. Each stack row must still
   match its live chair by seat id, player, joined_at and stack before. There
   must be no later commit, history or permit. The claim, lease, freeze and
   commit core are the same.

2. **The door reads play time, not write time.** Its level clock took the
   event's last dealt hand by `created_at`. A hand committed late is written
   now with the blinds it was played at, so the door, asked again right after
   the handoff, would have turned 8ec7e81d back from level 2 (40/80, ante 10,
   dealing today) to level 0 (25/50). The rolled-back probe showed exactly
   that. It now orders by `COALESCE(ended_at, created_at)`.

## Proved rolled back

On 2026-09-26 at 09:13 UTC, one transaction ran this exact handoff body as a
`pg_temp` function, then the door, then `ROLLBACK`:

- **Handoff:** success and an atomic commit. Permit 1713a446 was `accepted`
  with evidence 3a095f5f, and one history row was written.
- **Chairs after the handoff:** 21,045 / 5,050 / 5,000 (the bystander,
  unchanged) / 14,950 / 5,114 / 4,925 / 15,011 / 4,925 / 3,980. The
  registrations were equal to the chairs.
- **Door:** generation 7c88dac4 was accepted, the four preflop tables were
  aborted and credit was 0. With the old ordering the level went back to 0
  from 2. With the new ordering it stayed at 2.

## Five tests

| test                   | result                                                                       |
| ---------------------- | ---------------------------------------------------------------------------- |
| 1. read, not assumed   | PASS: the rows above                                                         |
| 2. nobody paid twice   | PASS: one-time handoff claim, idempotent commit core, neither changed        |
| 3. nothing clawed back | PASS: settled exactly as played, net 0; the bystander's 5,000 is not touched |
| 4. proved rolled back  | PASS: above                                                                  |
| 5. the paragraph       | PASS: this file                                                              |

Every player here is a horse. The same ruling applies to a human (CLAUDE.md
10.5).

## Replaced by 20260926131050 (2026-09-26 13:10 UTC)

`20260926091455` never reached the database and never could. Its pre-image
pins `fn_ca_resume_hand_submission` at `1aa58a5d`, and PR #5320
(`20260926091630`, applied) had already moved that body to `828edb10` with
its own late-chair clause for the same table. So the handoff half of this
change is live through #5320, and the file is deleted.

The door half was not live anywhere: `fn_f06_abort_abandoned_generation`
still read the last dealt hand by write time. `20260926131050` installs
exactly the reviewed door body above (`adeba11b`) on the live pre-image
(`f7424f0f`), asserts the live handoff is #5320's and leaves it alone.
