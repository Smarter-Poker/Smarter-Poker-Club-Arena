# An Unstarted Hand Releases Its Permit (2026-10-15)

Dan: "FIX THE STALLING TOURNAMENT TABLES AT THEIR ROOT CAUSE."

## What Players Saw

Spin, heads-up and MTT tables committed a hand cleanly, then dealt nothing for
about three minutes, until GameServer's 180 second `tournament_table_zombie`
reaper killed and rebuilt them. Zombie kills per day: 76 (10-11), 58 (10-12),
10 (10-13), 0 (10-14), 8 (10-15). They often came in pairs in unrelated
tournaments.

## Root Cause, Read From Rows

Every tournament zombie kill from 2026-10-11 to 2026-10-15 whose table had
dealt at all holds exactly one F06 permit above its last committed hand
(`smarter_private.f06_hand_permits`), `reserved` until the rebuild's
`f06_no_start_continuations` receipt turned it `never_started`. Examples:
ef900c4d permit 34605918 and 9aca69d4 permit 34605926, both reserved about
06:07:30 and released at 06:10:48 after the 06:10:25 kills. No hand evidence
exists for any of them: the hand was never started.

`ServerTableEngineDealing.dealHand` reserves the next hand's permit
(`fn_f06_begin_hand`) before it builds and starts the controller. Its `finally`
released a permit no hand had started on only when the table was paused or
stopped (written for the maintenance restart, #4858). Every other way an
attempt could end unstarted left the permit `reserved` while the table kept
running: `permit.start` refusing, a throw between reservation and start, an
early return, or a begin reply lost after SQL committed it (local phase
`unknown`). From then on every attempt was refused: the allocator answers
`hand_permit_unresolved` (`f06_allocation_unproven`) and `reserveF06Hand`
throws `f06_prior_hand_unresolved`. The loop's error backoff (3, 6, 12, 24, 30
seconds ...) reaches its tenth error after more than 180 seconds, so the reaper
always got there first.

## The Fix

- `ServerTableEngineBase.resolveUnstartedF06Permit`: the continuation that took
  the permit releases it through the existing durable door
  (`fn_f06_cancel_prepared_hand`, which refuses any permit with start
  evidence). A permit whose start was attempted is never touched. A permit in
  phase `unknown` first replays its exact begin (idempotent per permit_id).
- `dealHand`'s `finally` calls it whenever a running, unpaused attempt ends
  without a hand, and records `unstarted_hand_permit_released` with the cause
  (for example `start_failed:f06_start_unproven:permit=reserved`). The top of
  `dealHand` calls it too, for a release whose reply was lost, and then drops
  the refused preparation so the attempt allocates fresh.
- The zombie reaper records where the table stopped:
  `tournament_table_zombie:<loop phase>:permit=<phase>` (no seconds, so rows
  still group). Any future stall names its own line.

## Pinned By

`server/src/engine/AnUnstartedHandReleasesItsPermit.test.ts` (fails on the
previous main with `f06_prior_hand_unresolved` on the second deal) and
`server/src/fleetWideZombieVerdict.test.ts`.
