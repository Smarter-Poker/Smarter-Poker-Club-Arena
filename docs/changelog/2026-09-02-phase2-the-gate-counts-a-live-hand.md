# 2026-09-02 - Phase 2 of 9: the gate counts a live hand, not a raised hand

Engine-restart programme, `docs/ENGINE-RESTART-PROGRAMME.md`.

## The defect

The deploy's restart gate (`MaintenanceBreak.readyForRestart`) waited for
every table to report `isParkedBetweenHands()`, which is true only while a
loop is literally blocked on the pause-gate promise. A table anywhere else in
its loop - the wait loop's 5s sleep, `loadSeatedPlayers`, the idle broadcast,
the dealing loop between hands but before the gate - read as unparked with
no cards out. On the 17:55 break, with ZERO hands dealt inside it, 64-70 such
tables held the gate shut for the whole five minutes; the deploy gave up at
:00 and the fallback restarted the engine at 18:02 on live tables. The gate
had never once opened on any real break. This is the third wrong version of
the same predicate; all three are recorded above `unparkedTables()`.

## The fix

A table holds the gate iff it is running AND has a hand in flight -
`!isBetweenHands()`, i.e. `handController !== null`, which the engine sets
only after the hand-complete listener has settled the pot (verified at all
six null sites). This is the predicate the mystery-bounty phase already
trusts to move money only between hands. `maintenancePaused` still stops a
parked table starting a new hand, and `drainHands` still parks a straggler
at a hand boundary on SIGTERM, so opening the gate on "no cards out" loses
nothing.

The break now measures itself: tables in flight at countdown, the peak
during it, the first instant the gate opened, tables resumed, thaw result -
handed out at `end()` through a new `recordOutcome` dep, which GameServer
writes to `engine_maintenance_break_log`. Phase 1's scorecard reads it, so
`ca_break_scorecards` now carries `unparked_at_countdown`, `peak_unparked`,
`ready_for_restart_at` and `gate_opened` - the column it could not fill
before.

## Proof

- `MaintenanceBreak.test.ts`: the restart-gate block rewritten around cards
  in the air, never calling `park()`. **6 pins FAIL on origin/main's
  MaintenanceBreak.ts, 34/34 PASS on this branch.**
- `tsc --noEmit` clean. Full server suite run before push.
- DB half (`20260902213000`) applied live and proven in a rolled-back probe:
  service_role insert into the log, scorecard fills the gate columns, a break
  with no engine row reads NULL not zero.
- `MaintenanceBreak.test.ts` added to the named regression step of the
  required "Server Engine" check.

## What "done" looks like on a live break

The next break on this build: `engine_maintenance_break_log.ready_for_restart_at`
non-null, the deploy takes the CLEAN cutover path (not the straggler
escalation), and the scorecard shows unparked_at_countdown near zero.

## Addendum, 21:55 UTC: the dealing loop never parked either

The first break on the build carrying #2695 (34c6194b) dealt **3,110 hands**
inside the freeze - 663 / 657 / 626 / 607 / 557 a minute, against 161 / 5 / 0
on the last build that parked (93d167b5, via hand-for-hand). #2695 was
necessary and not sufficient, exactly as the handoff feared.

#2537 gave the break its own authority (`maintenancePaused`) and wired it into
the start-up wait loop; #2695 wired it into `isPausedByDesign()`. Neither
touched the two park gates in the DEALING loop
(`ServerTableEngineDealing.ts`), which still read `handForHandPaused` alone -
a flag `pauseForMaintenance` deliberately never sets. So a table that was
dealing at :53 finished its hand and dealt the next one, and the next. Only
quiet tables parked.

Both gates now consult `maintenancePaused`, the same shape as the start-up
loop gate. Pinned by a source law in `MaintenanceBreak.test.ts` (every
`awaitPauseGate` in the dealing loop must be guarded by `maintenancePaused`):
fails on origin/main, passes here. Server suite 3,657 / 3,657.
