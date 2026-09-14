# Bounded journal backlog reporting

The journal worker reports global unfinished work separately from its own cycle
counters. A service-only STABLE function inspects at most 257 unfinished rows,
using the existing partial index, and returns only aggregate counts and ages.
Completed history is excluded. No identifiers or public hand payloads cross the
worker boundary or appear in engine health.

The sample separates queued, leased and quarantined work; immediately ready work
includes expired leases. Buffered bytes, oldest work age and maximum attempts
make saturation and stuck work visible. More than 256 unfinished rows or 64 MiB
of buffered payload yields an explicit unavailable result. It never reports a
truncated subset as the whole queue.

The worker reads once per minute with a five-second transport deadline, inside
the existing serial cycle and thirty-second cycle watchdog. Three job calls,
one retention call and one health call total at most five transport deadlines;
the watchdog also covers local processing. Cancellation prevents a later read.
The parent validates the reply independently, strips unknown fields and treats
invalid replies, stopped workers or samples older than 75 seconds as unknown.
Fresh empty queue status means only that no unfinished durable job was visible
in that snapshot. It says nothing about pre-enqueue source loss or completeness.

Native verification uses a private PostgreSQL fixture and the actual compiled
worker with its unchanged HTTP client. It covers six queue states, row and byte
budget refusals, app-role denial, actual worker restart and shutdown, and all
earlier journal contracts. The combined fixture passes 31 groups and confirms
that its database and worker children were stopped and removed. Compilation
and focused tests also pass; full-suite and publication receipts are recorded
separately in the task evidence.

This change adds no source producer, changes no consumer cadence or poker
policy, and supplies no model-completeness flag. Durable discovery, measured
capacity, scoped model consumption, counterfactual evaluation, independent
holdout/shadow checks and controlled activation/rollback remain open.
