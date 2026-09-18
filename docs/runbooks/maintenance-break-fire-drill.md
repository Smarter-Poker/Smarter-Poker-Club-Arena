# Maintenance Break Recovery Drill

The former drill used direct root SSH and an ad hoc container kill. That path
is retired: a workstation may not mutate, restart, or publish the Club Arena
engine.

A live crash drill may run only after it is implemented as a reviewed,
default-branch Club Arena repository event with all of these controls:

- exact full merged SHA and pinned Hetzner host identity;
- explicit incident/drill authorization and a single owning release lane;
- table-safe maintenance-break admission before any process mutation;
- immutable before/after engine provenance and runtime-write receipts;
- automatic refusal when active-table or freeze preconditions are unclear;
- cache-busted health and hand-progression verification after recovery.

Until that controlled path exists, use the unit, integration, and rolled-back
database tests for maintenance-break recovery. Do not reproduce the retired
direct SSH/container commands from historical changelogs.

## When the gate will not open

`EngineReleaseGateNeverOpens` and `RestartGateHeldByUndurableTables` point here. The engine restarts only inside a break and only when `MaintenanceBreak.readyForRestart()` is true, which needs `unparkedTables().length === 0`. Read these in order; the first two are one scrape each and answer most cases.

**1. Which condition is holding it.** `poker_maintenance_unparked_tables{reason}` names it: `cards_in_air` is a hand still finishing and resolves itself in seconds; `accounting_pending` and `accounting_unconfirmed` are the time-bank accounting settle; `bank_park_write_incomplete` is initialized banks that have not reached their durable park row. `unknown` means an engine that publishes only the boolean, which should not happen on any build after 2026-09-18. `/health` carries the same breakdown as `maintenance.unparkedReasons`.

**2. Whether the gate has ever opened.** `engine_maintenance_break_log` holds one row per break, written at `MaintenanceBreak.end()`, with the first instant `readyForRestart` opened and NULL when it never did, alongside the tables in flight at the countdown and the peak during it. `ca_break_scorecards` has one row per hourly break and says whether the break stopped play, gave the clocks back and shipped. **Read these before the container log.** On the night of 2026-09-17 the same answer was reconstructed twice from `engine_presence_parked`, the container log and the source, at a cost of about two hours each time, while both tables held it already.

**3. Whether a release could have used the break at all.** This is the failure that looks like a shut gate and is not.

`engine-release-transaction.sh` needs `MIN_BREAK_REMAINING_MS` of break left before it will mutate anything: 150 seconds of candidate proof plus 135 seconds of rollback reserve, 285 seconds in total. A break's countdown is `MaintenanceBreak.BREAK_DURATION_MS`, five minutes. Tables do not write their park snapshots until the countdown begins. So the room the whole fleet has to park in is

```
countdown - MIN_BREAK_REMAINING_MS = 300000 - 285000 = 15000 ms
```

and a fleet of about 1,200 tables takes roughly thirty seconds. The transaction therefore refuses on every break, logging `the durable table break has NNNNNms remaining, below the 285000ms candidate-and-recovery budget`. Measured on 2026-09-18: the countdown opened at 298,411 ms and it refused fifteen seconds later with fifteen tables still unparked.

Worse, a transaction that cannot use a window still announces one, and an announcement parks every table on the platform for the whole window. Three transactions whose targets were behind `origin/main` cycled announcements and took 25 of the 33 minutes from 03:53 to 04:26, with hands per minute going 706 to 0 and back, twice. Their repeated pauses also cleared park checkpoints, so the unparked count never settled: **the attempts were manufacturing the condition that refused them.** Stopping the three units dropped unparked from 33 to zero within thirty seconds.

So when the gate looks permanently shut, check for this before believing it:

```bash
# Release transactions that are waiting, and what they are waiting for
systemctl list-units --all --plain 'club-arena-engine-release-v1@*' | grep activating
journalctl --since -20min -o cat | grep -oE '\[engine-release-transaction\].*' | tail
# Targets behind main refuse forever and should be stopped
journalctl -u club-arena-engine-release-v1@<run>.service -o cat | grep -oE 'target [0-9a-f]{40}'
```

A unit whose target is behind `origin/main` will never install and every announcement it makes is a fleet-wide outage for nothing. `systemctl stop` on it is safe: `Restart=on-failure` with `RestartPreventExitStatus=1` means a refusal does not restart, and nothing else re-arms a release. The announced window then expires on its own and play resumes.

**4. Only then, the engine log.** `docker logs --since 20m club-arena-engine | grep -iE 'parked|maintenance'`. The engine names the first five tables at each countdown.

## Installing a release when the gate is the only thing in the way

`/root/cutover.sh` on engine-01 runs exactly the sequence the transaction runs, through the same release seal, so the audit trail, the desired-release pointer and the supervisor all stay consistent. It proves the break directly rather than reading the certificate: active, counting down, durable, at least 200,000 ms remaining, and no hand dealt in the last 45 seconds. It aborts before mutating anything if any of that is untrue.

It takes `RUN_ID`, `RUN_URL`, `ACTOR` and `REASON` from the environment and every one of them is recorded. Use the run that actually built the image, with a distinct attempt suffix, so the seal's audit names a real build:

```bash
RUN_ID=<run>-2 RUN_URL=https://github.com/.../actions/runs/<run> \
ACTOR=<who> REASON='<why the automatic path could not>' bash /root/cutover.sh
```

It is not a substitute for the release path. It is what to do when the release path cannot certify itself, and each use should be followed by fixing the reason it could not.
