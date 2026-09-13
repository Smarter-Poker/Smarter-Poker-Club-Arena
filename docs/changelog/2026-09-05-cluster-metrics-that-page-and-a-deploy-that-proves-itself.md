# 2026-09-05: cluster metrics that page, and a deploy that proves itself

Three silent failures on 2026-09-04/05, every one found by a human reading
rows. None of them had a number a rule could read, so none of them could
page. This changelog records what now speaks for each.

## The three failures

1. **The controller's pass latch stalled for eleven minutes with no log
   line** (2026-09-04 22:10 UTC). A never-awaited wake parked a worker, the
   `inTick` latch stayed held, and every tick after it returned the stale
   summary. The controller had a rich event log (`cash_cluster_events`) and a
   per-pass summary (`ClusterTickSummary`); neither reached Prometheus.
2. **A deploy that "succeeded" shipped nothing.** The container came back on
   the OLD image and `/health.version` did not change. Every check in
   `auto-deploy-hetzner.yml` compared what the engine SAID over HTTP against
   the target; none remembered what was running BEFORE the cutover, and none
   asked the database what the engine WROTE about itself.
3. **The engine died at 04:05 under the 04:00 thaw.** The engine-level alerts
   (`EngineScrapeDown`, `EngineLivenessDead`) cover the process; nothing
   covered the controller that stops with it, and nothing distinguished "the
   controller is frozen by design" from "the controller is dead".

## What now pages

### Failure 1 and 3: the controller is measured (`server/src/cluster/ClusterMetrics.ts`)

The controller calls three things and nothing else: `recordPass()` at the end
of a pass (both the normal path and a failed worklist), `recordStalled()`
where it reports `tick_stalled`, and `recordSkippedFrozen()` where the freeze
stops it before any I/O. Six lines in `ClusterController.ts`; the module does
the rest. The series live in the ALWAYS-ON registry
(`observability/engineInstruments.ts`), rendered by
`GameServer.getPrometheusMetrics()` on every scrape. The `ENGINE_METRICS`-gated
registry is off in production; a metric nobody scrapes pages nobody.

| series                                                        | type      | what it says                                                         |
| ------------------------------------------------------------- | --------- | -------------------------------------------------------------------- |
| `poker_cluster_pass_duration_seconds`                         | histogram | wall time of one pass, seconds (buckets to 120 s, the stall ceiling) |
| `poker_cluster_pass_games` / `_ticked` / `_woken` / `_rested` | gauge     | the last pass                                                        |
| `poker_cluster_pass_errors_total`                             | counter   | per-game tick failures plus worklist failures                        |
| `poker_cluster_pass_stalled_total`                            | counter   | latches found held past `CLUSTER_TICK_STALL_MS` and released         |
| `poker_cluster_pass_skipped_frozen_total`                     | counter   | ticks the freeze refused                                             |
| `poker_cluster_passes_total`, `poker_cluster_rpcs_total`      | counter   | passes; RPCs when the summary carries `rpcs`                         |
| `poker_cluster_last_pass_timestamp_seconds`                   | gauge     | `time() - this` is the controller's silence                          |
| `poker_cluster_actions_total{kind}`                           | counter   | every action `fn_cash_cluster_tick` reported                         |
| `poker_cluster_games{state}`                                  | gauge     | live / dormant, from the worklist rows                               |

`kind` is derived from the action objects the SQL returns and is BOUNDED: an
id-shaped value folds into the bare key (`closed`, `feeder_abandoned`,
`second_chair_cashed_out`), only a short lowercase word is appended
(`feeder_opened`, `main1_reopened`, `state_dormant`), and past 64 distinct
kinds everything else is `other`. Never a table_id, never a game_id.

A frozen tick is a SKIP, not a pass: the timestamp does not move, so a frozen
controller looks stalled to the rule and the break guard is what silences it,
never a fake pass. That is what makes failure 3 visible: a controller that is
quiet OUTSIDE a break is dead, and the rule says so within a minute.

The sibling branch's `rested` and `rpcs` are read with optional chaining;
either summary shape works.

### The rules (`infra/monitoring/alert-rules.yml`, group `cluster`)

| alert                      | fires when                                                          | severity |
| -------------------------- | ------------------------------------------------------------------- | -------- |
| `ClusterControllerStalled` | no pass for 60 s while `up{job="engine_game_server"} == 1`, for 1 m | critical |
| `ClusterPassLatchReleased` | any `stalled_total` increase in 30 m                                | warning  |
| `ClusterPassErrors`        | 10 or more tick errors in 15 m, for 5 m                             | warning  |
| `ClusterTickingNothing`    | ticked == 0 with games > 0, for 3 m                                 | critical |
| `ClusterFeedersAbandoned`  | 5 or more `feeder_abandoned` in 30 m and zero `feeder_live`         | warning  |
| `ClusterMovesExpiring`     | 5 or more `moves_expired` in 30 m                                   | warning  |
| `ClusterPassSlow`          | p95 pass duration > 20 s over 10 m                                  | warning  |

EVERY rule carries the break guard from CLAUDE.md 13 rule 6, written as
`unless on() max_over_time(poker_maintenance_break_active[6m]) == 1`. The
`on()` is deliberate: most of these expressions aggregate their left side away
from `{instance, job}`, and a plain `unless` would then match no series and
guard nothing. (Several older rules in the same file aggregate and use the
plain form; they are out of scope here and noted for a follow-up.)

**One deviation from the brief.** It asked for `ClusterPassSlow` at p95 > 3 s.
The measured norm is ~10 s a pass (78 games, eight in flight, ~0.85 s per
tick RPC from Hetzner; `2026-09-05-cluster-autonomy-live-audit.md` BUG 3), so
3 s would have fired permanently and been muted within the week. 20 s is
twice the norm and four cadences. `theClusterPages.law.test.ts` pins the
limit above 10 s so it cannot drift back under the norm.

Routing needs no change: alertmanager routes by severity, and both `critical`
and `warning` reach `email-critical` / `email-warning`, which deliver. The
law test checks that too. `scripts/ci/check-monitoring-drift.mjs` (the
pre-push "7 rule file(s) loaded" check) is green.

### Failure 2: the deploy proves itself

The original September 5 repair used a two-mode CI witness to record the old
version and poll for the new one after cutover. On September 10 that interim
witness was retired. It had no remaining production caller and duplicated the
stronger, fail-closed release transaction now owned by the Club Arena host.

The durable replacement binds one requested main SHA to its exact image and
release run. The host transaction proves the candidate, local endpoint, public
endpoint, and fresh elected-leader database identity before sealing the
release. It then writes an fsynced per-run result. The observer accepts only
that authenticated result and independently rechecks the sealed image and all
three live witnesses. A missing or unreadable witness cannot become a success;
the systemd wrapper preserves retryable state or completes bounded terminal
recovery.

### /health

`GET /health` now carries, on the leader:

```
cluster: { lastPassAt, elapsedMs, games, ticked, woken, errors, rested, rpcs, stalled, skippedFrozen }
```

and `cluster: null` on a standby (the controller runs on the leader only).
`lastPassAt` ageing while the leader is up is the stall, readable without
Prometheus.

## How to see it

- Grafana: `infra/monitoring/grafana-dashboards/cluster-controller.json`
  ("Cluster Controller", uid `smarter-poker-cluster`) is picked up by the
  existing file provisioner. Panels: silence since the last pass against the
  break flag, pass p50/p95, worklist by state, errors/stalls/skips, actions by
  kind.
- Raw: `curl -s https://engine.smarter.poker/metrics | grep poker_cluster_`
  and `curl -s https://engine.smarter.poker/health | jq .cluster`.
- Prometheus: `time() - poker_cluster_last_pass_timestamp_seconds` is the
  one number to watch.

## Tests

- `server/src/cluster/ClusterMetrics.test.ts`: every series with HELP/TYPE,
  seconds not ms, kind derivation and its bound, per-kind counts across
  passes, error accumulation, state gauge, optional `rested`/`rpcs`, stall and
  freeze counters, the /health snapshot.
- `server/src/cluster/theClusterPages.law.test.ts` (registered in
  `docs/laws.d/`): a real tick lands in the always-on registry; a frozen tick
  is a skip; the released latch is counted (Date.now past
  `CLUSTER_TICK_STALL_MS`); the `cluster` group exists with all seven alerts,
  each break-guarded with `on()`, reading only metrics the engine emits;
  critical and warning route to a delivering receiver; /health wiring; the
  controller calls exactly the three hooks.
- `tests/unit/theDeployProvesItself.test.ts`: duplicate releases require a
  fresh exact source and runtime proof; candidate and final identity bracket
  the seal commit; shipped receipts require both a sealed result and independent
  verification; workflow, observer, unit, and transaction budgets remain
  correctly nested.

## Deliberately not done

- Older rules in `alert-rules.yml` that aggregate and then use the plain
  `unless max_over_time(...)` (no `on()`) are not corrected here; each needs
  its own look at whether the left side keeps `{instance, job}`.
- The engine-level "died at 04:05 under the thaw" root cause is not in this
  branch; this makes the controller's death visible and leaves the thaw to
  the engine-restart programme (`docs/HANDOFF_CURRENT_STATE.md`).
