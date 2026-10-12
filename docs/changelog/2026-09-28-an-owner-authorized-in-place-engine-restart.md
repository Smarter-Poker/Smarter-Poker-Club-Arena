# 2026-09-28 - One owner-authorized in-place engine restart (20:55Z break)

## Why a restart by hand, when the repo forbids one

`docs/SWARM-BRIEF-DIAMOND.md` says never to force or restart the engine by
hand, and #5288 and #5315 close the other exits (no custody exception, no
off-cycle window while the certificate refuses). This restart went ahead
because Dan authorized it explicitly on 2026-09-28 at ~15:10 CDT, after the
deadlock below was measured. It is recorded here so the next agent does not
read it as precedent: it was a single, named exception.

## The deadlock

- From 12:55Z the restart certificate refused every break (12:55 to 18:55Z,
  seven in a row, `engine_maintenance_break_log.ready_for_restart_at` null).
  From 16:55Z it refused with `unparkedReasons={stopped_bank_custody_stuck: 71}`.
- Cause: migration 20260928144831 (#5527) added a second overload of
  `fn_consume_time_bank`. The serving engine's two-argument call failed with
  PGRST203 from 16:05Z to 16:18Z, and 71 tables latched
  `timeBankAccountingUnconfirmed = true`.
- On the serving engine (763e4cec) that flag has no clearing path.
  `ServerTableEngineBase.ts` sets it at six sites and clears it only in the
  initializer. So every stop failed with "retained time-bank custody", and the
  census reported the tables as `stopped_bank_custody_stuck`
  (`neverHoldsGate: true`).
- The fixes were merged but undeployable. #5533 (database, applied) removed
  the overload. #5530 (engine) adds `resolveUnconfirmedTimeBankDebits`, which
  clears the flag in-process. Every release carrying #5530 was refused by the
  condition it fixes.

## What was done

`docker restart -t 45 club-arena-engine` on the serving image, inside the
scheduled 20:55Z break after every table had parked: SIGTERM, then
`drainHands`, then the same container and image boot, adopt the persisted
break row and thaw at :00. No certificate exception was added, and no
off-cycle window was requested.

What it discards: only the in-memory unconfirmed time-bank state of the 71
tables, which is seconds of time bank, not chips. The debits behind it never
ran (PGRST203 means the function never executed). Chips are in the database.

## Proof required, and recorded in the PR that carries this file

- `/health` `maintenance.stoppedCustodyStuckTables` 0 after boot;
- the next break's `engine_maintenance_break_log` row certified;
- the waiting release (5d46b091 or later, which carries #5530) live at
  `/health` `version`.

## Proof, measured on 2026-09-28

- Restart: container StartedAt 20:55:43Z, same image as before (763e4cec).
  `/health` `maintenance.stoppedCustodyStuckTables` read 0 from the first
  poll after boot, down from 71.
- The same 20:55Z break then certified. Its `engine_maintenance_break_log`
  row has `unparked_at_countdown` 0, `ready_for_restart_at`
  20:56:53Z, `thaw_ok` true and `tables_resumed` 530. It was the first
  certified break since 12:55Z.
- The waiting release went out in the recovery window that followed
  ("Deployment Recovery", announced 21:03:36Z). Engine Release run
  36475346573 for fa480b9b concluded `success`, and the new container started
  21:06:27Z. `/health` `version` reads `fa480b9b`, a descendant of 5d46b091
  that carries #5530. `stoppedCustodyStuckTables` read 0.
- Thaw: the release boundary lifted at 21:13:08Z. `/health` then read
  `active false`, `phase idle`, with 468 hands dealt in the next 30 seconds.
  No PGRST203 errors appeared and no `stopped_bank_custody` reason was
  logged.
- `horse_data_ledger` re-synced at 21:06:59Z from the new engine.

Seen after the thaw and NOT caused by this restart: two cash tables loop on
`retained_hand_submission_readback_failed`. 6c9ee4b6 fails with
HANDOFF_STATE_CHANGED and has not dealt since 2026-09-22. 499aa67a fails
with TABLE_NOT_ADMITTED and has not dealt since 18:26Z. Both stopped dealing
before either engine start today, and each needs its own investigation.
