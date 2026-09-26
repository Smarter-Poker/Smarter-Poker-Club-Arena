# A retained hand commits past a seat taken after its deal

2026-09-26. Migration `20260926091630`. Law
`tests/a-retained-hand-commits-past-a-seat-taken-after-its-deal.law.test.ts`.
Follows `2026-09-26-a-dead-generation-hand-that-never-reached-a-commit-is-a-misdeal.md`,
which held event 8ec7e81d for this reason.

## What was frozen

Event 8ec7e81d ($100 Freeroll 6:00 PM) has had five of its eight tables
stopped since 2026-09-18 23:08 UTC. Table c1ee060b holds
`smarter_private.hand_submissions` 3a095f5f: the engine's complete settlement
request for hand 12976717, retained at 23:08:14, eight seconds after the hand
ended. The generation that retained it (7c88dac4, instance 1-3846b8bb) died
before it dispatched the request.

The hand was played out. It was raised preflop and everyone folded:

| seat name (profile)  | user     | before | after  |
| -------------------- | -------- | ------ | ------ |
| iashford (BoatQueen) | 4ef643c1 | 14,936 | 15,011 |
| the_bubble (RakeRat) | 0c7ad36f | 21,095 | 21,045 |
| RVARay (FlopQueen)   | 7508c26e | 4,005  | 3,980  |
| five others          |          | same   | same   |

All eight are horses and the rake is 0. The other four tables each hold an
ordinary reserved preflop hand of the same dead generation. The
abandoned-generation door decides a whole generation at once, so they waited
behind this one.

## Why it could not commit

The platform already has the right door. `fn_ca_resume_hand_submission`
(20260922022319, the successor handoff) lets the current lease holder commit a
dead generation's retained request byte for byte through
`fn_ca_commit_hand_settlement`'s core. It does this once, under a
`hand_submission_handoffs` claim. The engine asks it at every table admission,
before the abandoned-generation door.

It refused every ask with `HAND_SUBMISSION_HANDOFF_STATE_CHANGED` (read with a
rolled-back probe at 09:04 UTC). The refusing clause required the number of
live chairs to equal the number of stacks in the submission. The table had
nine chairs; the hand had eight. The ninth chair is seat 3, LubbockPreston
(3ec4fbbc, a horse). He is a late registrant whose registration and seat were
written in one transaction at 23:08:36.700. That was 53 s after the deal
(started_at 23:07:43.117) and 30 s after the hand ended. He was never dealt
in, the hand cannot touch his chips, and he still holds his 5,000 starting
stack. Every other clause passed.

A late registrant taking a free chair between hands is ordinary poker, so the
seating was correct. The defect was the equality clause.

## The fix

That clause alone changes. A live chair missing from the submission is
admitted only if it joined after the hand's recorded `started_at` and its
player is not one of the hand's players. These still refuse:

- a chair that was present at the deal but is missing from the submission;
- a hand player seated twice;
- a submission with no recorded start;
- every earlier refusal (chairs, stacks, later commits, history, permits).

The commit is the retained request through the platform's core, unchanged.

## Five tests (8ec7e81d, hand 12976717)

| test                   | result                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. read, not assumed   | PASS: the retained request, its request hash, the eight chairs matching `stack_before`, the ninth chair's `joined_at` against the hand's `started_at`, and no commit, history or later permit.                                                                                  |
| 2. nobody paid twice   | PASS: one `hand_submission_handoffs` claim per submission, and `hand_atomic_commits` is keyed by (table_id, hand_number). The committed row's `hand_id` is the submission id, so a replay reads the same receipt.                                                               |
| 3. nothing clawed back | PASS: the result committed is the one the hand produced. Voiding it (a misdeal) would have taken 75 from the player who won it, so it was rejected.                                                                                                                             |
| 4. proved rolled back  | PASS: a one-block probe at 09:13 UTC, with this clause in `pg_temp`, completed the handoff and moved the three stacks above. Table 80,000 and registrations 535,000 were unchanged. The door then aborted the other four permits with credit 0. The planted regression refused. |
| 5. the paragraph       | PASS: below.                                                                                                                                                                                                                                                                    |

**Paragraph.** Hand 12976717 at c1ee060b is committed exactly as the engine
retained it. iashford (4ef643c1) takes the 125 pot and goes from 14,936 to
15,011; the_bubble (0c7ad36f) goes from 21,095 to 21,045 and RVARay (7508c26e)
from 4,005 to 3,980. The other five players at the table and LubbockPreston,
who sat down after the deal, keep their stacks. No chip enters or leaves the
event. The event's other four frozen hands (tables 6945f07e, 6c2a285d,
834cb21e and e6547587) are then aborted by the existing door. That door
returns no credit and restores the pre-hand stacks, which the probe measured
as unchanged totals. Every player is a horse and a human in the same chair
would get the same ruling (CLAUDE.md 10.5).

## Measured after apply

Recorded on the pull request once the apply door installs the migration and
the admission path has re-asked.

## Noticed, not changed here

- Migration `20260922022319` (the successor handoff) is applied in production
  but its file is only on the open PR #5058. This migration pins its exact
  body (`md5(prosrc) = 1aa58a5d...`) as the preimage and carries the complete
  new definition, so `main` now holds the live function.
