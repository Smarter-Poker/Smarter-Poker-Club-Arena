# An Expired Queue Entry Cannot Consume Fresh Equity Capacity

The equity queue relied on timeout callbacks to remove expired requests. When
the event loop is busy, a worker result or READY event can run before overdue
timeout callbacks. The pump then dispatches an already-expired request.

The earlier shared queue-plus-compute deadline could retire the healthy worker
for that request. PR #4266 separately replaced that deadline with independent
queue and execution budgets and added bounded recovery after a spent respawn
budget. Those changes are preserved here. Its pump still dispatched expired
queued work if READY or a result arrived before the queue timer callback.

The pump now checks the existing queue deadline before assigning a request to
a worker. Expired work follows the queue-expiration path, clears its pending
timer and never starts an execution timer. Insurance priority, per-class FIFO,
the full execution budget from dispatch, worker retirement for execution
timeouts, bounded recovery and the prohibition on synchronous fallback remain
unchanged.

Two regressions drive the real pool with delayed timer callbacks: an in-budget
insurance result overtaking an expired cosmetic request, and a replacement
worker announcing READY after a queued request has expired. Both fail against
the merged PR #4266 source; its other 16 lifecycle cases pass. The assertions
also require one queue expiration, zero execution timeouts, retained healthy
capacity, no remaining timers and successful fresh work.

The prior source passed 30 targeted tests and 880 tests in normal pre-push
checks. After reconciliation with #4266, all 46 tests in the five equity suites pass,
and the server TypeScript check passes.
Production acceptance requires the changed engine to run and retain healthy
capacity through the fleet resume.
