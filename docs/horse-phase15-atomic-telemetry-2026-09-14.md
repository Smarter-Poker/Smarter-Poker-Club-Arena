# Horse Brain Phase 15: atomic telemetry receipts by source release

Daily aggregate counters mixed releases and had no idempotency key. If a database write committed but its response was lost, restoring and retrying the drained counters could add them again. Counter and latency writes could also finish independently, leaving no atomic receipt connecting the two streams.

BrainTelemetryFlush now submits both streams through HorseBrainTelemetryPublisher and the service-only fn_horse_brain_flush_receipt writer. One immutable batch contains a random batch ID, worker-instance ID, sequence, exact release SHA or explicit null, collection timestamp, UTC day, counters and histograms. The publisher retains the same bytes and ID until it verifies the database's matching ID and SHA-256 acknowledgement. New events remain in their accumulators while a pending batch is retried. Concurrent local flushes coalesce. The existing lifecycle owns the timer and drains an in-flight operation on shutdown. The transport has a five-second deadline.

The database atomically inserts the private receipt and updates both existing daily aggregates. Identical retries return the recorded receipt without adding again. Conflicting content or worker sequence is refused. Sorted aggregate writes and bounded row/byte counts limit work. Receipt access is denied directly to anon, authenticated and service_role; only service_role may execute the definer writer. Its search path and lock timeout are fixed.

Only the new batch-receipt table has a 32-day retention window, with at most 64 expired rows removed per new batch. An expired input is refused before aggregate mutation, so deleting its deduplication row cannot make an exact retry additive again. The service records an explicit evidence-gap counter for a confirmed expiry refusal. Existing source records and aggregate retention are unchanged. Older extra histogram buckets are preserved when aggregates are extended.

## Verification

The focused contract suite passed 41 tests; the server TypeScript build passed. The full server suite passed 12,381 tests across 821 files, with 146 pre-existing cases in one unconfigured CashoutDeparturePostgres fixture file skipped. An intermediate full run found an old assertion requiring the former two-write implementation; it now verifies the actual atomic publisher wiring while the functional service tests prove retry and lifecycle behavior.

Native PostgreSQL proof covers an actual commit with a lost acknowledgement, exact readback, independent-process replay of a retained payload, 30 malformed inputs, rollback after the counter write, duplicate content/sequence refusal, concurrent writes, role restrictions, null source identity and expiry. Native concurrency testing initially exposed an interaction between the two unique constraints; the corrected writer returns one recorded result and one replay. A 4,096-feature bounded write took about 65 ms in the local fixture; this is not fleet latency certification.

Migration source version: 20260914130422. Installed history version: 20260914131457. SQL SHA-256: 55c947d3f27482bcd56c4fa738bdfdd1a1dd01cc44d6e0d39c1e9f0892912aaa. The installed function body matches the native fixture (MD5 4feed925e2c9689f3ee90023ec413325). Production ACL/RLS readback passed. No synthetic production batch was submitted; zero receipts at installation is not natural execution proof.

## Acceptance boundary

These are complete receipts for accepted telemetry batches, not a complete decision ledger. The retained pending batch is in memory; process crashes can still lose unflushed data. Collection time does not reconstruct individual event times or prove an entire source window complete. Missing release identity stays null. Protected publication, natural source-bound receipt observation, full deterministic decision replay, policy distributions and fleet/strength certification remain independently open.
