# 2026-10-19 - A table held for its launch is alive when the hold ends

## What happened

Since #7367 (prepared launches, engine release 6e3ab4f3e, 2026-10-18 21:58
UTC) a large tournament is seated minutes before its advertised start and every
table is held with `holdDealingUntil(launchStartMs)`
(`server/src/tournament/TournamentManagerBase.ts`, the pre-seat block).

At 01:30, 03:30 and 05:30 UTC on 2026-10-19 (Prime Time Free Buy, Early Bird
Freeroll, Midnight Free Buy, two events each) GameServer's 5-second zombie
sweep fenced 85, 88 and 46 of those tables as
`tournament_table_zombie:<load_next_hand_inputs|refresh_blinds>:permit=none`,
all with hand_count 0, at the start instant. Every first deal was delayed by a
rebuild and `ClubArenaEngineKillStorm` paged.

## Cause

`server/src/engine/ServerTableEngineDealing.ts`, the deal-hold branch of the
dealing loop (`if (this.dealHoldUntilMs > Date.now())`, phase
`spin_reveal_hold`). It slept in one-second slices and never called
`markProgress()`. Every other waiting branch of the loop (wait-for-players,
the idle sweep, the settlement wait) stamps progress on each pass.

While the hold stood, `isPausedByDesign()` covered the table, so nothing read
the stale clock. The instant the hold expired the table was no longer paused,
its first iteration entered `load_next_hand_inputs` / `refresh_blinds`, and
the sweep (`shouldBeDealing && !parkedOnPurpose && msSinceProgress() >
180_000`) judged it on a clock last stamped before the hold began - minutes
old.

## Fix

The hold branch now runs `waitOneDealHoldSlice()`, which sleeps the slice and
then, if the engine may still mutate, calls `markProgress()`. The stamp comes
after the awaited sleep, so it is earned by the loop returning, not by entering
the branch.

Not changed: the 180 s threshold, the sweep, `isPausedByDesign()`, the table
watchdog. No exemption by name, no net.

## Why this cannot hide a dead table

- While a hold stands the table was already exempt (`isPausedByDesign()` reads
  `dealHoldUntilMs > Date.now()`). The stamp exempts nothing new; it only moves
  the start of the 180 s window from "the hold began" to "the hold ended".
- Every hold is a finite wall clock: the admitted launch start
  (`Date.parse(startedAtIso)`), the booked start, the spin `effectiveHold`,
  the add-on break end and the mystery-chest deadline. `holdDealingUntil`
  ignores `NaN`. When it passes, the table is judged exactly as before.
- A loop wedged anywhere else never reaches the slice, so a table whose loop
  died under a hold still carries an aged clock at expiry and is condemned on
  the next sweep.
- A stopped or fenced engine (`lifecycleCanMutate()` false) earns no stamp.

## Pinned

`server/src/engine/AHeldLaunchTableIsLive.test.ts` drives the real engine
through the real slice:

- held 5 minutes, at expiry `msSinceProgress() <= 1 s`, not condemned by the
  sweep's predicate, no watchdog trip (fails before the fix: 300,000 ms);
- 181 s after expiry with no deal it is condemned;
- an unheld table stale 181 s is condemned;
- a held table whose loop never ran a slice is condemned the instant the hold
  passes;
- a stopped engine earns no progress from a slice;
- source pins: the loop calls the slice, the stamp follows the sleep, and the
  sweep still reads `isParkedByDesign()` and `msSinceProgress() > 180_000`.
