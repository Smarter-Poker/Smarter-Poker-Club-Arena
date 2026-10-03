# Scheduler noise that hid real failures (2026-10-03)

Measured on the engine logs for 00:00-05:10 UTC.

- **24 spawn_claim_failed across 9 schedules** (23503 on
  `tournament_schedule_spawns_schedule_id_fkey`). Every one was a schedule
  deleted between the pass's single read of active schedules and its spawn
  claims (none of the 9 ids exists any more); one report per pending date.
  `claimSpawn` now treats that FK as "retired": nothing spawned, the rest of
  that schedule's dates stand down for the pass, one console line.
- **57 "SNG creation failed: null"**. `createSNG` re-reported every seat-first
  atomic refusal with `JSON.stringify(null)`; the real reasons, already
  reported by `createSeatFirstGameAtomic`, were 54 `platform_frozen` (a board
  tick begun before :53 kept creating after the announcement) and 9
  `tournaments_club_id_fkey` (owner club deleted mid-pass), plus 9 genuine lock
  timeouts. Now: the board loop stops at the freeze, a frozen refusal stands
  down quietly, a deleted owner club is held out for the back-off and said once
  as information, and only the plain-insert path is reported by `createSNG`,
  with its real message. Lock timeouts remain reported.
- **Deep Stack Society guarantee refusals**: the last one was 03:09:30
  (bank 31,840 vs 31,561.50-31,729.50 promised). None since the weekly bank
  refill; nothing to change.
