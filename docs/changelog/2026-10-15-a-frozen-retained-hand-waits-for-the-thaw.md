# A Frozen Retained Hand Waits For The Thaw

## What Production Showed

`engine_recovery_events`, 2026-10-07 to 2026-10-09: on every engine-replacing break the same three cash tables were killed with `start_failed:start_load_table` and rebuilt between 130 and 480 times between :55 and :00 (for example 2026-10-08 13:00 to 13:59: 174 kills on 3 tables inside the break minutes). Each table held a retained hand. That loop is what `ClubArenaEngineKillStorm` paged (631 open rows).

## Root Cause

`ServerTableEngineBase.checkCrashRecovery()` asks `fn_ca_resume_hand_submission` for a cash table's retained hand on every start. The door keeps that hand behind the platform freeze before it touches any lease or claim:

- `HAND_SUBMISSION_MAINTENANCE_BUSY` when `pg_try_advisory_xact_lock_shared(530090,1)` fails (the cutover holds it);
- `HAND_SUBMISSION_PLATFORM_FROZEN` while `fn_platform_frozen()` is true.

`resumeRetainedHandSubmission` turned both into a plain `Error`, `start()` caught it as a crash and called `killForRestart('start_failed:start_load_table')`, which wrote a recovery row and let discovery rebuild the table into the same answer every few seconds until the thaw. Nothing about the hand was wrong, and no rebuild could change the answer.

## Fix

- `handHistory.ts`: the two freeze answers are a named `RetainedHandSubmissionFrozenError` (`RETAINED_HAND_FREEZE_REFUSALS`) with the unchanged log text. Every other caller still sees an ordinary `Error` with the message it always had.
- `ServerTableEngineBase.resumeRetainedHandAcrossTheFreeze()`: a cash start that meets the freeze keeps its generation and lease, stamps progress on each answer (the door was read; the reaper must not condemn a table waiting on the break), and asks the same door again at the engine's thaw edge (`onMaintenanceThaw`) or after a pause of at most five seconds, whichever is first. The wait ends the moment the generation is no longer current, and the existing fence in `checkCrashRecovery` then returns without dealing. Every other refusal is still a `start_failed` kill.

## Pinned

- `server/src/engine/aFrozenRetainedHandWaitsForTheThaw.law.test.ts` (new law, `docs/laws.d/a-frozen-retained-hand-waits-for-the-thaw.md`).
- `server/src/engine/aStandingRetainedHandRefusalHoldsTheTable.law.test.ts` now states that the two freeze answers are the freeze, not a standing refusal and not an ordinary retried failure.

## The Net

`ClubArenaEngineKillStorm` stays. It is now expected to stay silent through every engine-replacing break.
