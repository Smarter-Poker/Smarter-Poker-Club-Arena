# Tournament contention must return to its caller

Phase 13 production verification exposed PostgREST 14.5 repeatedly executing custom SQLSTATE 40001 failures internally. Production logged 188,521 such errors between 18:10 and 18:45 UTC, predominantly from the F06 hand guards. Pool acquisition failures delayed tournament reads and prevented reconnect verification.

The reserved migration changes nine error-code literals across seven exact captured function definitions. Failed F06 advisory try-locks now return 55P03 with the existing F06_RETRY_CANONICAL_LANE sentinel. Two ticket admission comparisons on already locked rows return 55000. Messages, predicates, locks, financial writes, ownership, permissions and configuration are unchanged. Unknown preimages refuse installation atomically.

The isolated PostgreSQL 17 harness reproduces the old error and executes the actual allocator and trigger bodies before and after installation behind global and tournament locks. It verifies unrelated lanes, retained cancellation and abort fences, rollback, exact definitions, metadata, drift refusal and replay behavior. Ticket and mixed-custody financial paths are compiled and checked for exact preservation; this harness does not claim to execute those financial paths. Required accounting CI executes the harness, with exact migration bytes pinned.

Protected merge, one qualified installation and production readback remain separate requirements. Existing installed Lightning migrations must not be replayed. Lightning remains disabled, and Phase 14 remains on hold until Phase 13 verification is complete.
