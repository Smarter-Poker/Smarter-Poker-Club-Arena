# The fleet nobody was running

2026-09-09

## What was measured

Production, 05:52 UTC, one engine, one leader:

```
/health    activeTables: 102      activeTournaments: 0      liveness: "ok"
/metrics   poker_tournaments_running 120
           poker_tournament_elimination_scheduler_registered 0
```

A full cash fleet and not one of a hundred and twenty tournaments. The process
reported itself healthy, and it was right to by every rule it had:

| liveness branch     | why it was false                                  |
| ------------------- | ------------------------------------------------- |
| `wholeFleetStalled` | the cash tables were dealing                      |
| `discoveryLoopDead` | the discovery loop was attempting every ~4.9s     |
| `barrenLeaderDead`  | it requires `tables.length === 0`; there were 102 |
| `dbConfirmedDead`   | the database was answering                        |

Underneath that green light, from the database at the same moment:

- **13 RUNNING tournaments had dealt no hand for over an hour.** The oldest,
  `$100 Freeroll 6:00 AM`, for **903 minutes** - just over fifteen hours.
- **183 players** were sitting `playing` in them.
- `$100 Freeroll 12:00 PM` held **41 open tables for 42 seated players** - forty
  of them with exactly one player, so not one hand could be dealt - plus 29 more
  players holding 5,000 chips with no seat at all.
- `poker_tournament_seatless_phantoms` read **50**, and
  `poker_tournaments_stuck_completing` read **25**.

None of it was reported by monitoring. It was found by hand, by typing SQL.

## The cause of the blindness

`services/TournamentMetrics.ts` was written for exactly this class of failure
and its header says so:

> The most valuable signal here is "a tournament that should be running is not",
> and an engine reporting only on tournaments it OWNS can never see it: the
> failure IS the absence of a manager. So these come from the database, which is
> the only place that knows what should exist.

Both halves of that are true, and only one of them was ever published. The
database half - `poker_tournaments_running` - shipped. The engine half, _how
many of those this process is actually running_, did not exist as a series at
all, so no rule could be written against it. `activeTournaments` sat in the
`/health` JSON, read by nothing.

That is `EngineLivenessVerdict.ts`'s own documented failure mode, one level up.
That file carries three separate notes about liveness signals that read healthy
while the platform was dark, each ending in a narrower guard; the last of them,
`barrenLeaderDead` (2026-08-30), was written for an engine serving _nothing_.
**An engine serving one whole fleet and none of the other was never covered**,
because the denominator it checks is "tables", and a cash fleet keeps that
number comfortably far from zero.

## The fix

The engine now publishes the other half, and computes the comparison itself:

```
poker_tournaments_owned            4     # managers THIS process holds
poker_tournament_fleet_unserved    0     # 1 = leader, past boot, fresh read,
                                         #     running > 0, owned == 0
```

`fleet_unserved` is computed engine-side rather than left to a PromQL
expression, because three of its four conditions are things only the process
knows, and each one is a state where the honest answer is "no":

- a **standby** instance owns nothing by design;
- a **booting** instance has not finished adopting;
- a **stale** snapshot means `running` is a number nobody has re-read - the
  collector deliberately keeps its last good value on a failed refresh, so past
  `FLEET_SNAPSHOT_MAX_AGE_SECONDS` (300s = five missed 60s reads) it is not
  evidence of anything. CLAUDE.md 10.86 rule 1: "I could not tell" is its own
  outcome and never gets folded into a confident one.

### It is deliberately not fatal

`fleet_unserved` is **not** wired into `evaluateEngineLiveness`. Killing a
process that holds a hundred live cash tables in order to fix an unserved
tournament fleet would void every hand in flight - which is precisely the
regression each of the three notes in `EngineLivenessVerdict.ts` was written
about. The verdict stays as it is; this is a separate signal with a reader.

### The reader

`TournamentFleetUnserved` in `infra/monitoring/tournament-rules.yml`, critical,
`for: 10m`, carrying the maintenance-break guard from CLAUDE.md 13 rule 6.

**Ten minutes is derived, not guessed.** The hourly break holds the platform for
five minutes and the engine is down for roughly two to three of them (park at
:55, new engine boots ~:58, thaw at :00 - CLAUDE.md 13), and re-adoption is a
five-second discovery pass. A scheduled restart cannot reach ten minutes. The
`unless max_over_time(poker_maintenance_break_active[6m]) == 1` guard is
belt-and-braces on top of that.

A rule is not live because it merged (10.84): it is live when
`curl -s localhost:9090/api/v1/rules` says so, after
`bash infra/monitoring/deploy.sh` runs on the box.

## What this does NOT fix

**Why the engine had adopted none of them.** That is the actual outage and it is
still open. Everything above is the missing measurement, not the repair - and
the distinction matters, because CLAUDE.md 10.12 forbids shipping a detector as
though it were the fix. It is not claimed as one here. What changes is that the
next occurrence is visible in ten minutes instead of fifteen hours.

The evidence available at the time pointed at admission rather than at the
balancer: `poker_tournament_elimination_scheduler_registered` was `0`, so no
manager existed to run the balance pass, the seating sweep or the elimination
sweep. The one-player-per-table shape and the seatless re-entries are downstream
of that, not causes of it. The Supabase MCP became unreachable partway through
(`select 1` timing out for fifteen minutes), which is why the admission path
itself is recorded as open rather than diagnosed.

Open, with the measurements, as tasks:

- **The 13 stalled tournaments / absent managers.** Needs the engine log for
  admission refusals; `GameServer.running_board_read_failed` and the tournament
  lease claim path are the first two places to look.
- **The bounty-evidence query.** `loadPersistedBountyEvidence` runs
  `table_id = ? AND status='succeeded' AND result @> {...} ORDER BY completed_at
DESC LIMIT 1` against `settlement_idempotency_keys`, which is 4,409,643 rows /
  3,172 MB with only a PK on `(table_id, hand_id)`. `EXPLAIN ANALYZE` on a live
  table: **8,523 ms**, 5,613 of 5,617 rows removed by filter, 3,156 disk reads -
  against an 8s `service_role` statement timeout. It errors, defers, retries and
  errors again.
- **`fn_after_tournament_rebuy` raising on a committed rebuy.** It refuses with
  `integrity_constraint_violation` when a player carries more than one
  unresolved knockout generation, and it runs _after_ the chips are credited in
  the same transaction - so the whole rebuy rolls back, permanently, for those
  players. Five users were in that state.

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- `npx vitest run src/services`: 155 files, 2233 tests, all passing, including
  the nine new pins in `theFleetNobodyIsRunning.test.ts` - one per refusal state,
  because a gauge that pages on a standby or a stale read is worse than no gauge.
- `node scripts/ci/check-monitoring-drift.mjs`: OK, 7 rule files loaded, mounted
  and non-empty.
