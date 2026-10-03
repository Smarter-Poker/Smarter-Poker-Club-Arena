# A sweep that waits on the wire is not rationed like one that burns the core (2026-10-03)

**Symptom.** `TournamentEliminationSchedulerSaturated` fired most hours overnight
2026-10-02/03 (oldest queued wait 279 s at 23:15 UTC, 311 s at 03:30). Sit & Go
and Spin winners were paid a p95 of 107-110 s after their last hand
(03:00-04:00 UTC: SNG p50 22.5 s / p95 106.6 s, Spin p50 26.9 s / p95 109.9 s).

**Measured cause.** The scheduler dispatched 1.0-2.2 sweeps a second in every
half hour of the previous 14 hours - slots / mean sweep (3.1-3.6 s) - while the
queue averaged 20-95 managers and peaked at 286. A sweep is a chain of awaited
PostgREST round trips from the Ashburn engine to the us-west-2 database:
~100-300 ms each at the engine, of which Postgres spent 5-40 ms
(`x-envoy-upstream-service-time`), with ~35 idle PostgREST connections and the
8-core engine's main loop at p99 ~25 ms. Ordinary Spin finishes
(FINALIZING -> COMPLETE) took p50 2.0 s / p95 6.5 s, serialized per bank scope
in Postgres at ~40% utilization. The four general slots (sized 2026-09-08 for a
one-core engine) were the bottleneck, not the database or the core.

**Fix.** `DEFAULT_MAX_CONCURRENT_SWEEPS` 4 -> 12 and `DEFAULT_DECIDED_SLOTS`
2 -> 4. The cap is still a hard ceiling (stall compensation still bounds real
concurrency at twice the cap); no database work is added, the same busts and
finishes run sooner. No money, F06 or finish path changed.

**Regression.** `server/src/tournament/anIoBoundSweepIsNotRationedLikeACpuBoundOne.law.test.ts`
(fails on the old constants, passes on the new). Alert annotations and the
saturation runbook no longer say "all four".
