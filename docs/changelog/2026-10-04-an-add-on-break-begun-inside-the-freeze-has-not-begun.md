# An add-on break begun inside the freeze has not begun (2026-10-04)

## What happened

Owner report: freerolls freeze. Read from `hand_history` and `tournaments`:

| event | window opened | break start before thaw | window end after thaw | last hand | next hand |
| --- | --- | --- | --- | --- | --- |
| `e51546f6` $100 Freeroll 6:00 AM (fade, 44 tables), 10-04 | 11:02:11 | 11:59:11 | 12:05:55 | 11:54:07 | 12:06:12 |
| `03ba4530` $100 Freeroll 6:00 AM (2a11), 10-04 | 11:01:04 | 11:58:04 | 12:04:48 | 11:53:48 | 12:05:03 |
| `a7d24468` $100 Freeroll 12:00 AM (fade), 10-04 | 05:02:24 | 05:59:24 | 06:06:12 | 05:54:41 | 06:06:53 |
| `bfcbea31` $100 Freeroll 12:00 AM (2a11), 10-04 | 05:01:17 | 05:58:17 | 06:05:05 | 05:53:52 | 06:05:37 |
| `afe0949c` $100 Freeroll 6:00 AM (2a11), 10-03 | 11:00:57 | 11:57:57 | 12:04:30 | 11:53:55 | 12:04:45 |
| `da75d640` $100 Freeroll 12:00 AM (2a11), 10-03 | 05:01:02 | 05:58:02 | 06:04:26 | 05:53:24 | 06:04:42 |
| `33a093ca` $100 Freeroll 6:00 PM (2a11), 10-02 | 23:01:55 | 23:58:55 | 00:05:22 | 23:53:12 | 00:05:50 |

"Window opened", "window end after thaw" and the two hand times are read from
rows (`addon_period_started_at`, `addon_period_ends_at`, `hand_history`). The
break start before the thaw is derived: opened + 57 minutes of entry
(`late_reg_mins`), the one-minute break being the 58th. The thaw moved each
window by its own measured freeze, 5m33s to 5m48s.

Each dealt zero hands in the five minutes before its one-minute add-on break,
and sat from the :53 last hand to the shifted window end, 11 to 13 minutes,
with no break announced. Every other event resumed at :01. A freeroll whose
window opened later (`86b3823c`, opened 11:05:19, break start 12:02:19, after
the thaw) dealt 179 hands in the same five minutes.

## Cause

`server/src/tournament/TournamentManagerBase.ts`, `scheduleAddOnBreak`.

The add-on break is the last `addon_break_minutes` of the durable window and
its start is a wall-clock timer. `fn_thaw_platform` moves
`addon_period_ends_at` forward by the frozen duration. For a break whose
pre-thaw start falls inside the freeze:

1. the start timer fires inside the freeze and `beginAddOnBreak` adopts the
   pause (`addOnBreakActive = true`, an absolute deal hold, no announcement);
2. the thaw re-read (`resyncAddOnPeriodAfterMaintenanceThaw` ->
   `drivePersistedAddOnDeadline` -> `scheduleAddOnBreak`) sees the shifted
   start in the future and arms a new start timer;
3. nothing gives the adopted break back. `isOnBreak()` stays true, the
   maintenance resume and the synchronized break both leave the tables to it,
   and they are released only at the shifted end.

The hourly $100 Freeroll starts on the hour and closes entry 57 minutes later,
so its break start lands in the :55 freeze whenever the window opened within
about three minutes of the start.

## Fix (engine, no schema change)

- `scheduleAddOnBreak`: when the durable window puts the break start in the
  future and a break is active, it calls
  `withdrawAddOnBreakBegunBeforeItsStart`, which gives the break back the way
  `finishAddOnBreak` does (flags, pause, level clock, hand-for-hand barrier)
  and then arms the start timer for the real deadline. A break that began
  before the freeze is untouched: its shifted start is in the past and the
  existing re-entry into `beginAddOnBreak` extends it.
- `ServerTableEngineBase.releaseDealingHold(atMs)`: releases a deal hold only
  when `atMs` is still the deadline in force, so the withdrawn break takes its
  absolute hold with it and a later hold from another authority is never
  shortened.

No timer, sweep or watcher was added. The correction is in the transition
that produced the wrong state.

## Pinned

`server/src/tournament/AnAddOnBreakBegunInsideTheFreezeHasNotBegun.test.ts`
drives the real scheduling and real table engines through the e51546f6
timeline. Three of its four cases fail on the old code (the break is still
active after the thaw re-read); the fourth pins that a break begun before the
freeze keeps its pause.

## Not verified

- Not deployed and not observed live. The first production proof is a $100
  Freeroll whose window opened before about :03 dealing hands between the :00
  thaw and its shifted break start.
- Events that take no synchronized break restart their level clock from the
  remainder saved when the withdrawn break suspended it, the same value
  `finishAddOnBreak` uses. `resyncLevelClockAfterMaintenanceThaw` runs
  immediately afterwards and re-arms from the durable anchor; that composition
  is reasoned from the code, not exercised by a test. Every freeroll measured
  takes the synchronized break, where the clock is not touched here.
