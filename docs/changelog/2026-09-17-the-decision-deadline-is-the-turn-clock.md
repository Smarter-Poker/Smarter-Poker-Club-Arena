# The decision deadline is the turn clock

Date: 2026-09-17. Engine change, phase 1 of the horse programme.

## What was wrong

A horse decision job expired after a fixed 8,000 ms of queue-plus-compute
time whatever the table's action clock was, and an expired job is a seat
taking the legal check or fold without thinking. Measured on engine-01 at
16:20 to 16:50 UTC with the main event loop at 200 to 500 ms p50: 23.5
fallbacks a minute, 27,548 expired decisions since the 14:55 boot, the
worker computing each answer in 12 ms. The decisions were not slow. The
queue in front of a saturated main loop was, and the caller deadline gave up
on them with seven seconds of a 15 s clock, and a time bank, still unused.

## What changed

- `horseDecision/decisionDeadline.ts`: `horseDecisionDeadlineMs` is what is
  left of the seat's action clock (`tables.action_time_seconds`, engine
  default 15) at enqueue, less a 1,500 ms margin to act on the answer,
  clamped between 2,000 and 30,000 ms.
- `LiveHorseDecisionWorkerClient.decideFast` and `decideDeep` accept
  `{ deadlineMs }`; the job's caller deadline is that number, or the client's
  fixed `jobTimeoutMs` when the caller passes nothing or nonsense. The expiry
  message names the deadline that applied. The worker-integrity (execution)
  deadline armed at dispatch is unchanged.
- `ServerTableEngineTurns` passes the turn-clock deadline for the fast
  decision and for the deep second look, both measured from
  `playerTurnStartTime`, the stamp the countdown pulses and the turn timer
  already read.

## Law

`server/src/engine/horseDecision/theDecisionDeadlineIsTheTurnClock.law.test.ts`
pins the number (fresh turn, turn under way, floor, ceiling, missing clock,
bad elapsed) and the client (a queued job outlives the fixed window and
answers inside the clock; a queued job expires at its own deadline with a
CANCEL, not a worker failure; no deadline or a bad one keeps the fixed
window).

## What was not changed

- The fixed window itself (8 s) and the worker-integrity window: a worker
  that does not answer a posted job in 8 s is still wedged and still fails.
- The fallback action (check or fold) when a job does expire.
- Nothing about main-loop capacity. A 260 ms event loop still expires
  decisions; this lets them use the clock they have. See the phase plan.
