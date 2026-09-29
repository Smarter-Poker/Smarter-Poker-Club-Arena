# Tables frozen

Runbook for four rules in `infra/monitoring/engine-freeze-rules.yml` (group
`engine-freeze`) that share it: `PokerTablesFrozen`,
`PokerTournamentTableNeverStarted`, `PokerEngineCannotBeReplaced` and
`PokerRestartGateHeldByStuckPermit`. Written 2026-09-26, when their runbook
link was replaced: it had pointed at
`https://monitor.smarter.poker/runbooks/tables-frozen`, which has never served
anything.

All four are produced by the engine's own `/metrics`
(`server/src/GameServer.ts`, the `freeze` block beside `getStatus`) and each has
a matching field on the public health endpoint, so the first read is always
the same:

```bash
curl -s --max-time 10 https://engine.smarter.poker/health | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("stalled", d["stalledTableCount"], d["stalledTables"])
print("summary", d["tableLivenessSummary"])
m = d["maintenance"]
print("breaksSinceRestartCertified", m["breaksSinceRestartCertified"])
print("unparkedReasons", m["unparkedReasons"], "f06StuckTables", m["f06StuckTables"])
'
```

## The question each rule asks

| Rule                                | Expression                                                                     | Question                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `PokerTablesFrozen`                 | `poker_stalled_tables > 0` for 1m                                              | Is a table with players seated making no progress?               |
| `PokerTournamentTableNeverStarted`  | `poker_tournament_table_never_started_oldest_seconds > 600` for 5m             | Is a tournament table's engine registered but never started?     |
| `PokerEngineCannotBeReplaced`       | `poker_maintenance_breaks_since_restart_certified >= 2`                        | Has the restart gate stayed shut for two breaks in a row?        |
| `PokerRestartGateHeldByStuckPermit` | `poker_maintenance_unparked_tables{reason="f06_preparation_stuck"} > 0` for 5m | Is a table holding an F06 preparation past its ten-minute bound? |

## PokerTablesFrozen

`poker_stalled_tables` counts tables with two or more dealable seats, not
paused by design, whose last observable progress (accepted action, turn change,
street, hand start) is over 120 seconds old. A healthy table under a 15-second
shot clock cannot reach that. `/health.stalledTables` lists up to 20 of them
with `tableId`, `dealable` and `secsIdle`.

The per-table recovery chain is: the table's own watchdog (tiers 1-3), then
`killForRestart`, then the 180-second zombie reaper, then a rebuild from the
discovery loop. That takes up to about three minutes end to end, so a single
table briefly in the list is the chain working. The alert fires after a further
minute, so a table that stays in the list past roughly four minutes is one the
chain did not recover.

First checks:

1. Is it one table or many? Compare `stalledTableCount` with
   `dealableTableCount`. Many tables at once is a systemic pause (database
   stall, event-loop stall, the break boundary) - read
   `PokerFleetWideStall`, `poker_event_loop_lag_ms` and
   `poker_main_event_loop_governor_scale` before the tables.
2. For one table, its phase:
   `curl -s 'https://engine.smarter.poker/health?liveness_table_ids=<tableId>'`
   returns `tableLiveness[]` with `loopPhase`, `running`, `paused` and
   `msSinceProgress`. Then the container log for that id:
   `docker logs --since 30m club-arena-engine 2>&1 | grep <tableId> | tail -50`.
   Look for `watchdog_`, `dealingLoop_died`, a settlement refusal, or a
   repeating error.
3. Its seats, read-only:
   ```sql
   SELECT s.seat_number, s.user_id, s.stack, s.status, s.joined_at, s.left_at
   FROM table_seats s WHERE s.table_id = '<tableId>' AND s.left_at IS NULL;
   ```
4. If `PokerSettlementBlocked` is also firing, the table is waiting on a
   settlement, not frozen: follow
   `docs/audits/2026-09-08-settlement-blockage-health.md`.

## PokerTournamentTableNeverStarted

A tournament table's engine is registered before it starts. If its start chain
fails, the engine stays registered with `running === false` and `dealable: 0`,
so `poker_stalled_tables` can never count it, and the zombie reaper skips it on
purpose because only its `TournamentManager` may replace that slot. The gauge
is the age of the oldest such engine. `/health.tableLivenessSummary` carries
`tournamentTablesNeverStarted` and `neverStartedOldestSeconds`.

First checks:

1. Which tournament owns the table:
   ```sql
   SELECT tb.id, tb.tournament_id, t.name, t.status, t.updated_at
   FROM tables tb JOIN tournaments t ON t.id = tb.tournament_id
   WHERE tb.id = '<tableId>';
   ```
2. Whether that manager is held or quarantined: `/health` fields
   `quarantinedTournamentManagers`, `tournamentManagersQuarantined`,
   `tournamentResumesFailing` and `tournamentLease`.
3. The start refusal in the log:
   `docker logs --since 1h club-arena-engine 2>&1 | grep <tournamentId> | tail -50`.

The fix lives in the manager's start path (`server/src/tournament/`), not in a
reaper that rebuilds the slot behind the manager's back.

## PokerEngineCannotBeReplaced

`poker_maintenance_breaks_since_restart_certified` counts consecutive breaks
that ended with no restart certificate (`MaintenanceBreak.ts`,
`breaksSinceRestartCertified`). One shut break is a lost window. Two means no
engine release, including a security fix, can reach production until the
reason the gate refuses is resolved. The felt is unaffected and will look
healthy; `/health.status` stays `ok`.

First checks:

1. `/health.maintenance.unparkedReasons` names the refusal. Reasons and what
   they mean are declared in `MaintenanceBreak.UNPARKED_REASON_BOUNDS`
   (`server/src/maintenance/MaintenanceBreak.ts`): `cards_in_air`,
   `accounting_unconfirmed`, `accounting_pending`,
   `bank_park_write_incomplete`, `f06_preparation_unresolved`,
   `stopped_bank_custody_unwritten`, `stopped_bank_custody_unreadable`,
   `unknown`, and the bounded `*_stuck` forms.
2. The durable record of recent breaks:
   ```sql
   SELECT break_started_at, break_ended_at, unparked_at_countdown, peak_unparked,
          ready_for_restart_at, tables_resumed, thaw_ok, engine_version
   FROM engine_maintenance_break_log
   ORDER BY break_started_at DESC LIMIT 12;
   ```
   A run of NULL `ready_for_restart_at` with the same `unparked_at_countdown`
   each hour is one table holding the gate.
3. The engine-release workflow runs (`auto-deploy-hetzner.yml`) will show the
   refusal from the other side.

## PokerRestartGateHeldByStuckPermit

The bounded half of the same fault. A table has held an unresolved F06
hand-number preparation for over ten minutes
(`MaintenanceBreak.F06_UNRESOLVED_GATE_MS`). Past that bound it is reported as
`f06_preparation_stuck` and no longer holds the fleet's restart certificate
(`neverHoldsGate: false`), so releases can proceed. The table itself is still
wedged. `/health.maintenance.f06StuckTables` and the container log name it.

The permit is process-local: only replacing that table's engine, or the next
process restart inside the :55 break, clears it. The root question is why the
preparation never resolved; start from the table's log lines and
`server/src/tournament/F06OriginalManagerFlow.test.ts` and its neighbours for the
lifecycle.

## What not to do

- Do not restart the engine outside the :55 break to unfreeze tables. It voids
  every in-flight hand on every table (CLAUDE.md sections 10.5 and 13).
- Do not delete `table_seats` rows or move chips by hand to free a table
  (CLAUDE.md 11.5 rule 3). Money probes are one rolled-back `DO` block per call
  (11.5 rule 1).
- Do not gate a table on `tables.status = 'paused'` (section 13 rule 3).
- Do not add a sweep, reaper or cron as the fix (10.11, 10.12). The zombie
  reaper and watchdog already exist; a table they cannot recover has a cause
  in a specific line, and that line is the fix.

## Where the owning code lives

- Gauges and `/health`: `server/src/GameServer.ts` (`getStatus`,
  `tableLivenessSnapshot`, the `freeze` Prometheus block).
- Restart gate and unparked reasons: `server/src/maintenance/MaintenanceBreak.ts`.
- Liveness verdict: `server/src/engine/EngineLivenessVerdict.ts`.
- Break schedule and invariants: CLAUDE.md section 13,
  `docs/runbooks/maintenance-break-fire-drill.md`.
