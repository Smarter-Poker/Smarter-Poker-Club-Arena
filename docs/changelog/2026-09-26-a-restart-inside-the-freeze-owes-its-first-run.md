# A Restart Inside The Freeze Owes Its First Run (2026-09-26)

## What Went Wrong

An engine restart lands inside the hourly break by design: the new engine boots
at about :56 and adopts the persisted break row. The rakeback settler's startup
run did not check the freeze (only its 30-minute interval tick did, since
2026-09-21), so it met the database freeze on its first cash-source batch,
halted with no page acknowledged, armed no 60 s catch-up and waited for the
next interval tick. Measured on engine-01 (release `cd5892e8`) on 2026-09-26:

- 13:56:26.808 `[MaintenanceBreak] Resumed a break left by the previous engine - 213s remaining`
- 13:56:26.820 `[RakebackSettler] Starting (interval: 30m)`
- 13:56:56 `[RakebackSettler.attribution_failures_hold_cursor] Cash source batch failed`
- 14:03:53 `daemon_state.rakeback_settler` still at 2026-09-26 13:52:12 while cash
  hands kept arriving: thirty minutes of settlement lost to one boot.

A catch-up armed just before :53 lands inside the freeze the same way.

## The Fix

`RakebackSettlerService.launchSettlement` now holds every launch made during a
freeze (startup, catch-up and interval alike) as the one tick the thaw owes, and
`start()` subscribes the thaw listener before its startup launch so a held
startup is paid. Nothing a cycle does changed; only when a held cycle starts.

This is engine code, so it is live only after an engine cutover at a
maintenance break.

## Regression Protection

`server/src/services/aFrozenTickIsStillOwed.test.ts`: four new cases (startup
inside the break, startup plus a missed tick, a catch-up landing in the freeze,
a stopped generation never revived). All four fail against the previous source
and pass against this one. `tests/fixtures/private-cash-earning-scope/source-binding.json`
is restamped with the reason (`freeze_holds_every_launch_rebinding_20260926`).
