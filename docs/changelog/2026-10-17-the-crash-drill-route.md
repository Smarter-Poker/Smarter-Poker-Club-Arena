# The controlled engine crash drill route (DA08)

The Diamond launch gates record
([2026-10-17-diamond-launch-gates-what-each-requires.md](2026-10-17-diamond-launch-gates-what-each-requires.md))
left DA08 failover unrehearsable: the engine has no warm standby by design, so
failover means an unclean death of the single engine and its restart by the
container supervisor, and the runbook had retired the only way anyone ever
rehearsed that (a direct SSH container kill) without a replacement.

This change builds the replacement the runbook specified. A live crash drill is
now one `drill-club-arena-engine` repository event, handled by
`.github/workflows/engine-drill.yml`, which stages the exact protected-main
`engine-crash-drill.sh` and `engine-drill-database-proof.py` on the pinned host
and runs them as a durable systemd unit.

## What the drill does

- Refuses, with nothing mutated, unless:
  - the requested SHA is the sealed desired release and the serving container
    is that exact image under production supervision;
  - the release lane is free;
  - a scheduled break passes the release transaction's own certificate, with
    the same rungs.
- Holds the engine mutation lock a release cutover holds, so a drill and a
  cutover can never share a break. A waiting release always takes the break
  first.
- Mutates once: SIGKILL to the engine's process from the host, an OOM-style
  death with no drain and no lease release. `docker kill` is avoided because
  Docker treats it as a manual stop.
- Proves recovery came from production supervision:
  - the same container restarted on the sealed image;
  - a new instance is the exact local and public release and the fresh database
    leader;
  - the restarted process adopted the durable break;
  - after the break: `thaw_ok`, a thawed freeze row, and hands dealt after the
    thaw.
- Falls back only to the existing forced desired-runtime restore, and records
  that as a failed drill.

The runbook ([maintenance-break-fire-drill.md](../runbooks/maintenance-break-fire-drill.md))
gives the request and every check.

## Verification

- `tests/operations/engine-crash-drill.py` runs the REAL script against a
  stubbed host whose "engine" is a real process. It covers:
  - a pass that needs every witness and never touches the forced restore;
  - thirteen refusals, each for its own stated reason, none of which signals the
    process;
  - a supervisor that never restarts, which fails and forces the sealed runtime
    back;
  - a restart that reports the old instance, which fails;
  - missing hand progression after the thaw, which fails.
- `tests/operations/engine-drill-database-proof.py` pins the database witness:
  one complete recovery passes, and twelve distinct gaps each refuse.
- `tests/a-crash-drill-is-a-reviewed-repository-event.law.test.ts` pins:
  - the single repository-event trigger;
  - a workflow that never touches Docker or a process;
  - exactly one SIGKILL, only after the final certificate read and under the
    lock;
  - admission rungs evaluated from the transaction's own arithmetic;
  - the shared engine lock;
  - the forced-restore fallback.

## What this does not yet prove

Building the route does not close DA08: the gate closes when one drill runs
inside a scheduled break on production and its receipt says `passed`. DA10
(rollback, then roll-forward) needs a separate rollback route through the release
transaction and seal, which is the next build.
