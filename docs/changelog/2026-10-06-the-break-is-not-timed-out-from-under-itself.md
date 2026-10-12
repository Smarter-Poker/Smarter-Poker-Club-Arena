# The break is not timed out from under itself (2026-10-06)

## Symptom

After an engine release cutover, the zombie sweep in `GameServer` killed and
rebuilt a batch of tables a few seconds after the thaw
(`engine_recovery_events`: `watchdog_kill_rebuild`, `cash_table_zombie` /
`tournament_table_zombie`, `hand_count` 0). Every one was parked like its
neighbours, dealt again within about two minutes of the rebuild, and harmed no
player - but a repair firing is a P0 (CLAUDE.md 10.12), and it rebuilt live
tables at the one moment the fleet is busiest.

Measured from `engine_maintenance_break_log` joined to the kills within 90s of
`break_ended_at`:

| break ended (UTC)   | build    | kills | kill span    |
| ------------------- | -------- | ----- | ------------ |
| 10-05 18:00:27.935  | 5815ef35 | 6     | :34.6-:34.8  |
| 10-05 19:00:38.064  | 5083089f | 0     |              |
| 10-05 20:00:32.050  | c5be0012 | 0     |              |
| 10-05 21:00 / 22:00 | c5be0012 | 0     | (no cutover) |
| 10-05 23:00:28.170  | 20b8acb5 | 51    | :32.5-:38.3  |
| 10-06 00:00:28.071  | 0a6e9cc3 | 24    | :33.9-:34.7  |
| 10-06 01:00:32.100  | 8f931f90 | 0     |              |
| 10-06 02:00:25.587  | 2c3410bc | 30    | :32.1-:32.2  |

Kills happen only on a cutover hour, and only when the certified release lands
before about :00:31. A cutover whose release lands at :00:32 or later kills
nothing. The killed tables have no configuration in common. Among the horse
cash tables that dealt between 23:40 and 23:54 on 10-05, killed and surviving
tables have the same spread of variant, size, bomb pots and cluster
membership. The 2026-09-04 batch is over-represented only because it makes up
most of the cash fleet.

## Cause

1. An engine built after the cutover (boot at about :55:45) is parked by
   `MaintenanceBreak.adopt()` with `remainingParkBudgetMs()`. That budget is
   the scheduled end of the break plus 30s, so the gate's safety timer fires at
   **:00:30**.
2. After a cutover, the break does not end on schedule. It ends on the
   certified release, at about :00:28, and its eight resume waves then take
   another 10.5s, finishing at about :00:38.5.
3. At :00:30, `awaitPauseGate`'s safety timeout
   (`server/src/engine/ServerTableEngineBase.ts`, the `setTimeout` in
   `awaitPauseGate`) released every table still waiting for waves 2-7. The
   self-resume cannot deal: every gate checks `maintenancePaused` and parks
   again. Before it gets back to a gate, though, the loop runs a full pass of
   the start-up wait loop inside the freeze. That pass reads the roster and the
   Cluster halt, runs add-ons, sit-out eviction and idle seat moves, and
   broadcasts.
4. A resume wave that arrived during that pass found `handForHandResolve ===
null`. `releasePauseGate()` only credits the progress clock to a table that
   is actually at the gate (the 2026-09-18 rule, kept), so the table came off
   the break with its clock still anchored at process boot, more than 280
   seconds without progress.
5. The next sweep, about 4 to 10 seconds after the thaw, found the table
   should be dealing, was not parked, and was more than 180 seconds stale, so
   it called it a zombie.

An hour without a cutover is safe because tables parked at :53 carry
`PARK_BUDGET_MS` (8 minutes). Their timer runs to about :01, after the last
wave.

## Fix

While the maintenance break still holds the table, the safety timer re-arms
instead of releasing the gate. A self-resume under the break could only ever
park the table again. Its one effect was to walk the loop out of the gate,
which threw away the thaw's progress credit and ran wait-loop work inside the
freeze. The break's own resume reaches every engine, and a table it misses is
still reaped by the paused-too-long bound once the break stops holding it.

The timer re-arms rather than retiring. When the break lets go of a table that
hand-for-hand or another authority still holds, `resumeFromMaintenance` defers,
and the gate keeps its safety net. A pause with no break behind it still
self-resumes exactly as before.

What was not changed: the zombie threshold, the credit rule in
`releasePauseGate` (a table that never reached the gate still gets no credit),
and every watcher. Nothing new watches or repairs anything.

## Tests

`server/src/engine/TheBreakIsNotTimedOutFromUnderItself.test.ts` drives the
real engine gate on the production timeline. The four cases are:

- an engine adopted at :55:45 and woken by wave 2 at :00:31 stays parked
  through :00:30, gets the credit, and is not a zombie at the first sweep;
- a table that does not deal after the thaw still trips the 180-second zombie
  verdict;
- the safety net survives the break for hand-for-hand;
- an ordinary pause still self-resumes after 120 seconds.

The first and third cases fail on the previous code.
