# Maintenance Break Recovery Drill

The former drill used direct root SSH and an ad hoc container kill. That path
is retired: a workstation may not mutate, restart, or publish the Club Arena
engine.

A live crash drill may run only as a reviewed, default-branch Club Arena
repository event with all of these controls:

- exact full merged SHA and pinned Hetzner host identity;
- explicit incident/drill authorization and a single owning release lane;
- table-safe maintenance-break admission before any process mutation;
- immutable before/after engine provenance and runtime-write receipts;
- automatic refusal when active-table or freeze preconditions are unclear;
- cache-busted health and hand-progression verification after recovery.

## The controlled crash drill (DA08)

That route is `.github/workflows/engine-drill.yml`, which runs
`server/scripts/engine-crash-drill.sh` on the engine host as a durable systemd
unit. It is requested with one repository event; there is no input form, timer
or workstation path:

```json
{
  "event_type": "drill-club-arena-engine",
  "client_payload": {
    "drill": "crash",
    "expected_engine_sha": "<full sha of the release serving now>",
    "authorization": "<who approved it and why, 12-200 characters>"
  }
}
```

What it does, in order. Any unclear fact before the kill refuses with nothing
mutated:

1. Refuses unless the requested SHA is the sealed desired release, the serving
   container is that exact image under production supervision
   (`restart=always`, `autoheal=true`, `sp-autoheal` running), local `/health`
   is that release, and no release or intake unit and no seal pending cutover
   exists.
2. Waits, for up to 70 minutes, for a scheduled break that passes the release
   transaction's own certificate (counting down, durable, `readyForRestart`,
   `unparkedTables == 0`, `handsInFlightTotal == 0`, the scheduled reason) with
   the transaction's ordinary 260,000 ms rung left. A release waiting for the
   same break always takes it; the drill stands aside.
3. Takes the engine mutation lock a release cutover takes and re-certifies at
   the locked 245,000 ms rung. It then records the before receipt: the instance,
   container, start time, restart count, process id, public instance, and the
   database leader with a heartbeat under 15 s.
4. Reads the certificate once more, then sends SIGKILL to the engine's process
   from the host, the way the out-of-memory killer ends it. This is the only
   mutation. `docker kill` is not used, because Docker records it as a manual
   stop and that would rehearse an operator, not a crash.
5. Proves recovery came from production supervision alone, with the forced
   restore reserve kept back from the break end:
   - the same container restarted on the sealed image within 60 s;
   - a new instance reports exact local health within 180 s, and the same
     instance is served publicly;
   - that instance became the database leader with a fresh heartbeat;
   - it adopted the durable break it was killed inside.
6. After the countdown, proves the engine left the break, the break outcome row
   says `thaw_ok`, the freeze row was thawed, and at least 20 hands on 5 tables
   were dealt after the thaw.

If supervision does not restore the engine in time, the drill runs the existing
forced desired-runtime restore (`engine-supervisor.sh` with force-desired, exact
health and the caller-held lock) and records the drill as failed.

The receipt (`/var/lib/club-arena/engine-drills/<run>.json`), the append-only
`audit.jsonl` beside it and the unit journal are retained as the workflow
artifact. The run passes only when the receipt says `passed`. Pinned by
`tests/a-crash-drill-is-a-reviewed-repository-event.law.test.ts`.

Do not reproduce the retired direct SSH/container commands from historical
changelogs.

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
