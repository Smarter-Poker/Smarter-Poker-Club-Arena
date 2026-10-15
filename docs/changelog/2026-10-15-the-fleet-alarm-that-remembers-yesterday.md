# 2026-10-15 - the fleet alarm that remembers yesterday, and the solver host that finished

Two alarms that told the wrong story, or none, for a day or more.

## 1. HorseFleetThroughputRelativeDrop (runbook)

**What happened.** From 2026-10-13 13:15 UTC to 2026-10-14 23:03 UTC the Midway Union floor
stayed parked (the operator park, since made a 60-minute lease with a watchdog by #6885) and
`atomic_table_buyin` refused about 32,000 horse seats. Every fleet rule was an absolute floor set
below the night trough, so the first page came about eight hours in.

**What the rule asks.** Is fleet-wide `rate(poker_hands_dealt_total[30m])` under half the mean of
the same 30 minutes on the previous 1..6 days (only the days Prometheus still holds, at least
three), for 30 minutes, outside the maintenance break? The baseline is the recording rule
`sp:hands_dealt:same_hour_mean_6d` in `infra/monitoring/alert-rules.yml` (group `horse-fleet`).

**Measured** from `hand_history`, hourly, against the mean of the same hour 1..6 days earlier,
2026-10-05 to 2026-10-15 12:00 UTC:

|                                      | hours | ratio              |
| ------------------------------------ | ----- | ------------------ |
| healthy, baseline over 7,200 hands/h | 132   | min 0.79, p01 0.84 |
| stall, 13:00 hour (began 13:15)      | 1     | 0.33               |
| stall, 16:00 10-13 to 22:00 10-14    | 31    | 0.01 to 0.22       |

Before 2026-10-08 the platform dealt tens to a few thousand hands an hour and the ratio was noise
(3 hands against 96 reads 0.03), so the rule only arms when the baseline is over 2 hands/s.

**When it fires.**

1. Look for a parked or refused club floor first: `ca_horse_fleet_heartbeat`, latest rows,
   `detail.gates.buy_in_refused` (keyed by refusal reason) and `detail.gates` generally.
2. Check operator floor parks and whether their lease has expired without release.
3. Per-club hands in the last hour from `hand_history` say which floor stopped.
4. If every club dropped evenly, read the engine alarms instead (`EngineFleetThroughputCollapsed`,
   `EngineCoreSaturated`): that is an engine problem, not a floor.

**Proved offline** by `tests/monitoring/fleet-relative-throughput.test.yml`, run in CI by
`scripts/ci/test-fleet-throughput.sh`.

**Still missing:** a Prometheus counter of `atomic_table_buyin` refusals by reason. Today they reach
only the heartbeat table, so `HorseSeatRefusalsByReason` cannot be written yet; it is listed with
the other rules waiting on a producer at the head of the `horse-fleet` group. `page: sms` reaches a
phone only once the name is on the World Hub pager allowlist; until then it is emailed.

## 2. fn_audit_solver_pipeline_liveness: a finished host is not a stale one

Migration `20261015134134_a_finished_solver_host_is_not_a_stale_one.sql`. Since 2026-10-07 the
daily audit raised critical `solver_worker_stale` for M1 and M2, which had both exited 0
(`worker_state = 'completed'`, all rows done). `solver_worker_stale` now needs a non-terminal state
as well as a heartbeat over 15 minutes old. The real fault gets its own critical,
`solver_dataset_abandoned`: a dataset in `building` for over 24 hours whose host runs all completed
and whose compactor last reported `failed`, with the compactor's error in the title. In production
that names `horse-v31-authored-study-20261006-r2` ("cell has no live training combinations") and
`horse-v31-relative-v2-pilot-20261007-r1` ("required Phase 4 ... coverage is incomplete").
Pinned by `server/src/engine/aFinishedSolverHostIsNotAStaleOne.law.test.ts`.
