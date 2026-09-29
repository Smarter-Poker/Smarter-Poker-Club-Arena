# 2026-09-29 - A retained hand settles past an undealt chair, and on a closing table

Authorized by Dan in chat ("proceed"), after the horse audit remediation
found two cash tables crash-looping on `retained_hand_submission_readback_failed`.

## What was wrong

- **6c9ee4b6** (6 horses, 1,568.30 chips; stuck since 2026-09-22): hand
  13637742 was refused with HAND_SUBMISSION_HANDOFF_STATE_CHANGED. Two horses
  sat down 43 s and 18 s before the deal and were not dealt in. The handoff
  admitted only chairs taken after the deal (20260926091630).
- **499aa67a** (3 horses, 684.60 chips; stuck since 2026-09-28 18:26 UTC):
  hand 16812749 was refused with HAND_SUBMISSION_TABLE_NOT_ADMITTED because
  the table was 'breaking', and the handoff admitted only 'live'. The original
  commit path never checks a cash table's lifecycle.

The disposal door (20260928134553) leaves requests whose named chairs are
unchanged to this handoff, so nothing else could release either table.

## What changed

Migration 20260929022629 makes two clause-level changes to
`fn_ca_resume_hand_submission`, applied by exact replacement of the verified
live body. The pre-image md5 is 32cfcc98 and the post-image md5 is e2c4c0da.

1. A cash table in 'breaking' is admitted. 'closed' still refuses, and so
   does any tournament table outside its existing rules.
2. A chair that was present at the deal but is missing from the submission
   is admitted only when all three hold:
   - the hand's own record never names its player;
   - the record's `players` is an array;
   - every player it names is in the stacks.

Everything else is unchanged:

- A player seated twice still refuses, and so does an undated deal.
- The settlement core still refuses any stack set that does not conserve.

## Proof

- **499aa67a:** proved in a transaction that rolled back, using the live
  lease. The hand committed once, stacks went from 684.60 to 680.35
  (-4.25 = rake 3.75 + bbj 0.50), and a second call found nothing.
- **6c9ee4b6:** evaluated read-only against its live rows. It has 2 blocking
  chairs under the old clause and 0 under the new one, with net deltas 0.00.

Law: `tests/a-retained-hand-settles-past-an-undealt-chair-and-on-a-closing-table.law.test.ts`.
