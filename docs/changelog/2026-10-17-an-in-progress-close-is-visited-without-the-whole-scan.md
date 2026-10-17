# An in-progress close is visited without the whole scan

The Midway Oct 5-12 union close (167 attempts) stopped advancing after its 10:08 UTC certifying step on 2026-10-17. Every job 272 tick after that ended at the 240-second statement limit with nothing committed.

Measured on production, read-only:

- Before any book is visited, `fn_process_weekly_accounting_scope` ran its scope-eligibility scan over every standalone cash and tournament earning source. It took 9.6 s warm and more than 95 s cold (1.14M fee-source key reads, about 1.7 GB from disk per tick).
- The in-progress union visit itself took about 36 s warm: preparation 24 s, the cash commission check 11 s, the second preparation 0.6 s. The evidence report took 11 s warm and 51 s cold.
- The scan plus a cold visit did not fit in one tick. On the alternate ticks, the standalone club's no-op visit used the time first.

When the first scope of a tick is an in-progress book, the tick visits only that book and ends. In-progress rows of the scan come only from books with a running, chunk-committed run. When no club book is in that state, every such row is a union row, and a union's eligibility reads only unions, floors and runs.

Migration 20261017121500 computes those union rows with the scan's own expressions. If one is in progress, it returns the exact in-progress prefix of the same ordering, and a one-time filter keeps the full scan from being read. In every other case the full scan runs as before.

On production, the rewritten query returned the same first scope as the original in 0.68 s with 41 buffers. The original took 27 to 56 s at the same moment.

The native PG17 regression installs the exact production pre-image and covers 400 randomized scope sets (83 owned ticks, 317 full scans) for prefix and full-order parity. It shows the scan is never executed on an owned tick. It also proves every installer guard, atomic rollback, scheduler ownership and unchanged function metadata.

No payment, wallet, certificate, partial, period, budget, memo, ACL, trigger or sealed inventory source changes. The function is not one of the forty sealed sources, so the basis generation and the current certificates are unchanged.

## Only a chunked tick owns the fast path (20261017132500)

The engine's 8 s service_role probe also calls the coordinator, without chunking. Before 20261017121500 the probe always ran out of time inside the scan and recorded nothing. With the fast path it reached the in-progress book at 13:14:58 UTC, was cancelled 8 s into the visit, and marked the book `in_progress_visit`. That gave the book's place back on the next job 272 tick.

Migration 20261017132500 adds `AND v_chunked` to the ownership test. The probe now reads the full scan exactly as before, and job 272 ticks keep the fast path. The native regression checks both cases: the unchunked scan equals the original on every case, and the chunked scan equals 20261017121500's.
