# 2026-10-23 — Source-bound serial journal index installation

The existing migration applier accepts `--serial-journal-index` for the exact
merged `20261022223439_adaptive_journal_metadata_cover.sql` bytes and its single
concurrent cover index. The supported session-pool route authenticated correctly
but ignored startup `PGOPTIONS`, leaving eight maintenance workers available.
The opt-in now explicitly sets `max_parallel_maintenance_workers = 0` and verifies
zero on the same PostgreSQL backend immediately before sending that index.

The option requires the configured Supabase session endpoint, port 5432, project
role, and `postgres` database. The backend must be primary with both effective
and session roles `postgres`. A failed binding refuses before sending the index;
actual concurrent-build failures retain the existing durable-outcome handling.
Recovery and other special migration modes cannot use this option. No global
configuration, migration bytes, ordinary installer behavior, concurrency timeout,
break-window admission, or migration-history checks change.

Qualification: the existing required `contract-index-recovery.test.mjs` job now
covers exact-source/mode/endpoint rejection, backend identity and setting refusal,
no index send on binding failure, and the maintained applier's invocation order.
Local Node tests pass 14/14; syntax and diff checks pass. The explicit authenticated
read-only session preflight separately verified worker zero and stable backend.
The new module is included in the existing accounting CI input classification;
its routing regression fails before that input is registered and passes afterward.
Source preparation is not migration installation or completed cleanup proof.

The existing hosted installer also accepts the explicit `serial_journal_index`
dispatch input. Only that mode selects session port 5432 from the configured
provider endpoint; the project, role, database and credential remain unchanged.
Unverified endpoints and other ports refuse. The option remains present when
recovery inputs are also supplied so the applier rejects mixed modes, rather
than silently discarding the serial request. Eighteen focused installer tests
cover the hosted wiring and connection selection as well as the original guards.
Integration retains the newer Chicago recovery and maintenance owner behavior
and both parents' historical qualification records. Only current classifier and
nested source-binding identities are refreshed; no financial result is restamped.
