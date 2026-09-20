# The gate says why it is shut (2026-09-18)

## What was wrong

The engine restarts only inside the :55 maintenance break, and only when `MaintenanceBreak.readyForRestart()` is true, which requires `unparkedTables().length === 0`. On the night of 2026-09-17 that never happened:

| Break | Unparked tables | Behaviour |
| --- | --- | --- |
| 17:55 | 30 | flat for the whole five minutes |
| 18:55 | 22 | flat |
| 19:55 | 25 | flat |
| 23:55 | 3 | flat |
| 00:55 | 16 | flat |
| 01:55 | 22 | flat; cut over by hand |
| 02:55 | 22 falling to 17 | falls during last_hand, then flat |

The fleet ran for eight hours on the build from 16:56 while four merged fixes — including the fix for the very bug that was holding the gate — sat in main unable to install.

Finding out why cost two separate hours of archaeology, because the only number published was the count. Every one of those tables had logged `Parked between hands`, none had a presence-persist error, and none had a refused park write. The reason had to be reconstructed from `engine_presence_parked`, the container log and the source: at the 23:55 break, three tables parked two minutes *before* the countdown, so `pauseForMaintenance` cleared their park-write flag and their loops — already asleep in `awaitPauseGate()` — never ran the line that writes it again. At the 02:55 break, on a build that fixes exactly that, seventeen cash tables held the gate for a different reason that the published numbers still could not name.

A gate that can refuse for four different reasons must say which one.

## What changed

`ServerTableEngineBase.maintenanceDurabilityReason()` names the condition that is false, in the order the gate cares about:

- `accounting_unconfirmed` — a time-bank accounting outcome is unknown
- `accounting_pending` — a time-bank accounting write has not settled
- `bank_park_write_incomplete` — initialized banks have not reached the durable park row
- null — nothing is false

`isMaintenanceStateDurable()` is now `maintenanceDurabilityReason() === null`, so the boolean the gate reads and the reason an operator reads cannot disagree.

`MaintenanceBreak.unparkedTables()` counts the reason for every table it refuses, with `cards_in_air` for a table that is not between hands, and `unknown` for an engine that publishes only the boolean. The breakdown appears on `/health` as `unparkedReasons` and on `/metrics` as `poker_maintenance_unparked_tables{reason}`, zero-seeded so a rule can read a reason before it has ever been the reason.

Two rules in `infra/monitoring/recovery-rules.yml`:

`EngineReleaseGateNeverOpens` fires when `poker_maintenance_break_ready_for_restart` has been 0 for every scrape in three hours — three consecutive missed breaks, which is the shape of last night with nothing else to notice it.

`RestartGateHeldByUndurableTables` fires when the gate is held for four minutes by tables whose reason is not `cards_in_air`. A hand finishes in seconds; a checkpoint that never becomes durable does not resolve on its own, and one such table holds the whole platform's release.

## Verified

`tsc --noEmit` clean. The seven new cases pass, and so do all 196 existing tests across the eleven `src/maintenance` files, including the gate's own contract tests. `check-monitoring-drift.mjs` passes: every metric the rules name has a producer and both runbooks resolve. `promtool check rules` on the box's Prometheus v2.55.1 accepts the file.

This does not open the gate. It makes the next break say, in one scrape, which of the four conditions is holding it — which is what last night cost two hours for.
