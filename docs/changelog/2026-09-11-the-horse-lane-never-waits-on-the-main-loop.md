# 2026-09-11 — The horse lane never waits on the main loop

## The defect

Every horse decision runs on the one live HorseLogic worker thread, behind a
single FIFO that the main thread feeds (`server/src/engine/horseDecision/`).
The client posted exactly one job and waited for its answer before posting the
next. Each answer therefore had to wait its turn on the MAIN event loop -
behind table timers, broadcasts and settlement - before the next job could
even be posted, and the worker sat idle for that whole round trip.

Production, 2026-09-11, build `c113fbe7`, ~11:50 UTC with ~185 tables dealing:

| reading                           | value                      |
| --------------------------------- | -------------------------- |
| `liveHorseDecision.queueDepth`    | 126-156                    |
| `oldestQueuedAgeMs`               | 2,636-3,752 ms             |
| lane throughput                   | ~40 jobs/s                 |
| per-job compute (`lastComputeMs`) | 2-38 ms                    |
| busiest engine thread             | < 60% of one core (top -H) |
| `telemetry.avgHandDurationMs`     | 26,048                     |

Prometheus: `poker_horse_decision_worker_queue_depth` averaged 98-130 after the
10:55 deploy (2-7 all morning); oldest-queued age averaged 2.1-2.8 s with peaks
of 6.4 s. Horses acted seconds after the think time they chose, so hands slowed
for every seat at those tables, the worker governor shed Monte Carlo precision
(`EngineSheddingPrecisionForHours` pending) and a longer backlog would have
started expiring decisions at the 8 s job budget.

The one-at-a-time rule was there "so worker scheduling cannot reorder
RNG-consuming decisions". The order never depended on it: a MessagePort
delivers in post order and the worker chains every request onto one promise,
oldest first, answering in the same order.

## The fix

- **client.ts** keeps up to `maxInFlight` (default 4) jobs posted, so the
  worker always has its next job waiting on its own port. FIFO is still
  enforced (an answer for anything but the oldest posted job is terminal
  protocol corruption). An abort or expiry of a posted job sends CANCEL and the
  job keeps its slot until its terminal answer, as the single active job always
  did. The integrity (execution) clock starts when a job reaches the HEAD of
  the posted FIFO, never at post time, so a job waiting behind a slow
  predecessor can never fail a healthy worker (a failed worker restarts the
  fleet). The dispatch barrier still holds every post, so a priority effect
  commit still lands after older work and before its TURN_CHANGE successors.
  `status()` adds `inFlightJobs`; `queueDepth` counts both queues;
  `oldestQueuedAgeMs` covers everything behind the running head.
- **workerRuntime.ts** starts each job on its own event-loop turn
  (`setImmediate`). Node hands a port's queued messages to JS back to back (up
  to max(queued, 1000) per wake-up, draining microtasks after each), so without
  the yield a full window would run as one long macrotask and starve the
  worker's governor sampler, its persistence/telemetry flush timers and CANCEL
  handling.

## Proof

- `server/src/engine/horseDecision/client.test.ts`: the pre-existing wire-
  sequence tests pin `maxInFlight: 1`; a new `pipelined lane` block proves the
  default window (refill, FIFO corruption, CANCEL of a posted job, head-anchored
  integrity clock, barrier + priority commit, recoverable error, graceful
  drain). All 7 new tests fail against the previous client.
- `workerRuntime.test.ts`: a CANCEL delivered on a later macrotask is honoured
  for the second of two posted jobs; it fails against the previous runtime.
- `npx vitest run src/engine/horseDecision/` 70/70; `tsc --noEmit` clean.

## What to watch after deploy

`/health` `liveHorseDecision.queueDepth` should sit near `inFlightJobs` (<= 4)
with `oldestQueuedAgeMs` in the tens of milliseconds; `avgHandDurationMs`
should fall; `poker_equity_governor_scale` should hold at 1 outside genuine
saturation. If demand ever exceeds one core of HorseLogic the queue grows again
and the governor sheds precision as designed; the next step then is a second
lane, which needs HorseMind state replicated or partitioned first.
