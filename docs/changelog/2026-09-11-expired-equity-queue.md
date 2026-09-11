# An Expired Queue Entry Cannot Consume A Fresh Equity Worker

The equity queue relied on timeout callbacks to remove expired requests. When
the event loop is busy, a worker result or READY event can run before overdue
timeout callbacks. The pump then dispatches an already-expired request. Its
timeout immediately retires the healthy worker, which can consume the last
replacement and leave the pool failed.

The pump now checks a queued request's existing deadline before assigning it to
a worker. An expired request follows the existing timeout rejection path while
it is still queued, so no worker or replacement budget is consumed. The same
bounded queue-plus-compute timeout, active-worker retirement, insurance
priority, per-class FIFO ordering, finite replacement budget, and prohibition
on synchronous fallback remain in place.

Two regressions drive the real pool with delayed timeout callbacks: an
in-budget insurance result overtaking an expired cosmetic request, and a
replacement worker announcing READY after a queued request has expired. Both
fail on the previous source; the other 16 lifecycle cases pass. With the
repair, all 30 tests in four equity, capacity and runout suites pass. The tests
also prove the retained worker can serve fresh work and is not retired by the
late timeout callback.

This is a reproduced capacity-loss path, not a claim that every production
equity timeout had this cause. Production acceptance requires the changed
engine to run and retain healthy capacity through the fleet resume.
