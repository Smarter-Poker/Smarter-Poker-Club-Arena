# Every horse thinks in real time (2026-10-16)

Dan's requirement: every horse makes every decision with the full brain, in
real time. Measured the same day, it did not.

## Before (read-only, release 5780828e and 4c3509e5)

| What                                                       | Measured                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monte Carlo scale, 36,758 live decisions (10 min, ~17:20Z) | 1.0: 9.1%, 0.6: 87.6%, 0.35: 3.2%                                                                                                                            |
| Request -> journal, same window                            | p50 5,966 ms, p99 8,867 ms (compute p50 27 ms, p99 150 ms)                                                                                                   |
| Second looks                                               | 6 in 36,758 decisions; 37.7% of qualifying close spots declined by the queue or the governor; 13,560 of 14,064 deep looks started that day (96%) never acted |
| Opponent memory                                            | one HorseMind per decision worker, each learning only its own tables                                                                                         |
| Engine host                                                | 8 logical CPUs (4 EPYC Milan cores, SMT), 30 GiB RAM, 80 GB disk (17.3 GB free); load 8.8                                                                    |
| Per thread (top -H, 18:43Z)                                | 3 decision workers 81-95% each (nice 10), main loop 79%, HorseLeagueComputeProcess 96% (nice 19, child of the engine, PM league window)                      |
| Journal                                                    | 3 shards; capacity rule admits 3 on this disk; 0.84-0.93 GiB/h per shard; shard 2 (4 GiB) holds 4.8 h                                                        |
| Decision demand, 18:41-18:51Z                              | 72.1 decisions/s, 2.14 worker-seconds of compute per second; request -> journal p50 371 ms, p90 2.4 s, p99 3.4 s                                             |
| Cost of the full sample (same window, same hour)           | fast decision mean 30.4 ms at scale 1 vs 28.9 ms at 0.6 (NLH tournament 51.0 vs 51.0, PLO4 tournament 21.9 vs 17.7, PLO6 25.0 vs 17.9)                       |
| Floor by hour (hand_history, 7 days)                       | quietest 13:00-18:59 UTC (28.8k-37.3k hands/h), 04:00-07:59 at 40.0k-42.6k, peak 23:00 at 45.5k                                                              |

## What changed

1. **G1, the worker decides with the qualified brain.** The decision worker's
   own EquityLoadGovernor sampled the worker's own event loop, which is nothing
   but its decisions, so any busy worker cut its Monte Carlo. Every Phase 10-13
   strength league qualified with `EQUITY_GOVERNOR off, scale 1`. The worker
   thread is now spawned with `EQUITY_GOVERNOR=off` (`client.ts`,
   `horseDecisionWorkerEnv`) and refuses readiness if its governor could still
   cut the sample (`workerRuntime.ts`, `assertDecisionWorkerRunsFullSample`).
   Every decision journals scale 1. No cut path remains, so there is no cut
   counter: the measured cut bought 5% of CPU and never protected the clock
   (the 6 s queue happened with 91% of decisions cut).
2. **G2, capacity.** `lane.ts` defaults to one yielding decision worker per
   physical core (four on this host, eight on sixteen logical CPUs), still
   bounded by logical CPUs less two and by the journal's disk. The Horse League
   no longer competes with live decisions: both windows moved into the
   quietest hours (13:00 and 16:00 UTC; was 04:00 and 16:00), and a run starts
   its compute process and each matchup only while the lane's oldest queued
   decision is at most 1 s old (`decisionLaneHasHeadroom`). The age is taken
   over DECISION jobs only (`DECIDE_FAST`, `DECIDE_DEEP`, `DECIDE_DISCARD`;
   `status().oldestQueuedDecisionAgeMs`, per shard and lane-wide): every
   completed hand is now mirrored to every shard (G5), and gating on the age
   of that observation and mirror traffic would starve the league on a busy
   floor while no horse was waiting. The engine image
   build stays on the host: PUBLISHING.md requires the Hetzner build, and it
   already runs in a 1-CPU, 2 GiB cgroup, serialized by a host lock.
3. **G3, the second look is budgeted from the turn clock.** It was budgeted
   from what the queue left of the chosen think time and declined whenever the
   worker governor was below 1. Now the budget is what is left of the action
   clock less the engine margin (`horseTurnBudgetMs`), the governor gate is
   gone, and the action waits for the deep answer inside that budget
   (`v44_second_look_awaited`; `v44_second_look_hold_expired` when it never
   lands and the fast answer acts). A close spot can take longer than the
   chosen think time, never longer than the clock.
4. **G5, one floor, one read.** Every completed hand reaches every shard. The
   owner observes and journals it as before; every other shard learns it in an
   isolated HorseMind sandbox and adds exactly that hand's contribution
   (`mindMirror.ts`), so the dedupe caches of its own hands in flight are never
   displaced and the recency window decays exactly as observe() decays it.
   Bounded: 1,024 pending mirrors per worker (`horse_mind_mirror_shed`
   beyond), 20,000 remembered hands for dedupe per worker.

No file inside a Phase 10/11/12/13 policy digest was changed (HorseMind.ts,
HorseEval.ts, EquityLoadGovernor.ts and protocol.ts are untouched).

**The think timer is still per table.** The pin in
`server/src/MultiTablePlay.server.test.ts` ("the think timer is per-engine
state, armed per table") read `this.horseActionTimer = setTimeout(`. G3 split
the action out of that timer: the think timer is `const thinkTimer =
setTimeout(...)` held in `this.horseActionTimer`, and when it fires with the
deep read still out the wait is a second timer held in the same field
(`this.horseActionTimer = secondLookHoldTimer`), so `cancelHorseDecisionWork`
clears whichever one the turn is on. Every path that acts (think timer, hold
expiry, deep answer landing) goes through `commitDecision`, whose first check
is the commit fence (controller, hand number, lease, abort controller), and a
deep answer that lands on a cancelled turn never acts. The pin now names that
mechanism, and `HorseDecisionEffectCommit.test.ts` proves it in behaviour for
every policy receipt: a deep answer landing after the turn was cancelled, or
after the hand moved on, while the action was waiting for it never acts.

## FOLLOW-UP: the mirror must merge the opponent-exploit counters

**Not done here, on purpose.** The 2026-10-16 policy bundle (branch
`claude/horse-brain-requal-bundle-20261016`, hashed files) adds a decaying
opponent read: `HorseMind` keeps `exploitCounters` per `<scope>|<user>` and
the sandbox carries them as `HorseMindSandbox.exploit`, updated with
`decayAndAdd(row, increments)` from `HorseOpponentExploit.ts`. Neither exists
on main, so `mindMirror.ts` is not written against them. When the bundle is on
main, `mergeSandboxIntoLiveMind` (`server/src/engine/horseDecision/mindMirror.ts`)
must also add each `sandbox.exploit` row into the live row with `decayAndAdd`
(a sandbox row starts from `freshExploitCounters()`, so it holds exactly the
mirrored hand's increments). HorseMind exposes only a read
(`HorseMind.getExploitCounters(userId, scope)`) on that branch; creating a row
for a player the live mind has not seen needs a HorseMind entry point for its
private `exploitCounters` map, which is a hashed-file change and belongs to
the bundle (or its follow-up), with a `mindMirror.test.ts` case that a mirrored
hand moves `HorseMind.opponentRead` exactly as the owner's observe() does.
Until then a shard that does not own a table learns that table's hands for
every read except the bundle's exploit read.

## Arithmetic

Demand at the measured hour, full brain: 2.14 x 1.05 (full sample) + 0.05
(second looks, roughly doubled) + 0.01 (mirrors: 19.4 hands/s x 2 other shards
x under 0.3 ms) = 2.31 worker-seconds per second.

| Workers                      | Measured hour (rho) | Peak hour, x1.41 (rho)                    |
| ---------------------------- | ------------------- | ----------------------------------------- |
| 3 (today; the disk admits 3) | 0.77                | 1.09: saturates, as it already did at 0.6 |
| 4 (one per physical core)    | 0.58                | 0.81                                      |
| 8 (16 logical CPUs)          | 0.29                | 0.41                                      |

The queue wait measured at rho 0.71 was p99 3.4 s. Scaling by rho/(1-rho):
three workers at the measured hour p99 about 4.6 s, four workers at peak about
6 s, eight workers at peak about 1 s, against a 13.5 s decision deadline on a
15 s clock. Three workers at the peak hour cannot hold the clock with or
without the cut, which is why the host needs more cores.

## Production actions outside this repository (not performed)

1. Rescale the engine host (Hetzner Cloud server 132435945, `ash`), currently
   8 dedicated vCPU / 32 GB with the 80 GB disk kept from its first plan, to
   **ccx43 (16 dedicated vCPU, 64 GB, 360 GB) with the disk upgrade**, inside a
   :55 break. The lane then defaults to 8 decision workers and the journal
   capacity rule admits them; no configuration change is needed.
2. Until then the journal capacity rule holds this host at 3 workers. An
   operator may set `HORSE_DECISION_WORKERS=4` in the host's `server/.env`
   (explicit counts are not bounded by the journal rule): a fourth 4 GiB shard
   is about 6.2 GB on disk against 17.3 GB free, below the worst-case reserve
   the rule keeps.

## Tests

`mindMirror.test.ts` (a mirrored hand teaches exactly the owner's read,
including across recency halvings; dedupe; nothing marked for flush; in-flight
dedupe survives 2,500 mirrored hands), `fullBrainWorker.test.ts`,
`HorseLeagueLaneHeadroom.test.ts` (including: a mirror backlog is not a horse
waiting, a queued decision is), `client.test.ts` (the client reports the oldest
queued decision apart from mirrored-hand traffic), the V44 plan tests, the
deep-look reconciliation modes `after_think_time` and `hold_expired`, the two
late-deep-answer modes `cancelled_while_awaited` and
`successor_hand_while_awaited`, the moved per-table timer pin, the lane count
and broadcast tests, and the worker runtime mirror path.
