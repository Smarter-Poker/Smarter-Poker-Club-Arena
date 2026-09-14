# Isolated journal processing lifecycle

Journal processing now has a dedicated worker thread, separate from both the
table event loop and the live Horse decision worker. The leader bootstrap
starts one owner after leadership is established; standby starts none. That
owner participates in the existing external shutdown ownership barrier.
An unconfirmed worker termination remains a shutdown failure.

The worker imports its service transport and parses public payloads inside
its own thread, capped at256MiB old-generation and32MiB young-generation
heap. Only lifecycle messages and allowlisted aggregate statuses cross IPC;
batch payloads, actor identifiers and credentials do not. `/health` reports
`adaptiveJournalWorker` independently of dealer routing readiness. Its counts
describe this process's work cycles, not unique observations or source coverage.

Each serial cycle claims at most one durable job and runs at most one bounded
retention pass. Completed work waits one second, idle waits five seconds, and
uncertain or rejected outcomes back off from two to sixty seconds. The queue
retains its own per-job retry schedule and leases. Retention normally runs at
most once per minute, revisiting a capped pass after five seconds; no result
claims that the backlog is fully drained.

Startup must become ready within ten seconds. Heartbeats expire after fifteen
seconds, and an active cycle has a thirty-second watchdog even when heartbeats
continue. Recovery waits for confirmed termination before replacement and
allows three automatic restarts per hour with one/five/thirty-second delays.
Failed termination retains ownership and prevents another worker from starting.
Graceful stop cancels future cycles and restarts, waits up to twenty seconds
for the in-flight operation, then requests termination with a five-second
confirmation budget. Unknown database outcomes remain recoverable through the
existing immutable payload, receipt and lease contracts.

Verification includes252focused tests, actual leader-bootstrap and shutdown
function execution,28native PostgreSQL groups with cleanup, compilation and
11,538full server tests across785files with145existing skipped tests and one
skipped file (83.69s). The native fixture runs the actual compiled worker and
unchanged Supabase HTTP client against a private local PostgreSQL fixture. It
records a durable job, processes it and retention, kills the real thread,
observes a replacement, then verifies stopped children and no later RPCs.
The parent timer continued to run; this is not production capacity proof.

Initial validation caught an over-specific worker test-double interface and
a test cleanup handler attached after its rejection. The interface now models
only methods the lifecycle uses, and cleanup observes rejection immediately.
The final checks retain original timing/ownership guards. Earlier failed
validation logs remain in the evidence package.

This is a live background consumer of already queued public evidence. Durable
source discovery before enqueue, source completeness, scoped model use,
counterfactual candidates, independent holdout/shadow evaluation and gated
activation/rollback still remain. It does not change poker policies, manufacture
observations or complete Phase14.
