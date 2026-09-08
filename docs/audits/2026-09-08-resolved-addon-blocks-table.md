# A delivered add-on blocks the reported Madness table

At 17:47 UTC the reported table 58b2c844-9057-445e-ae0b-7850edcf9078 still showed hand 8251566. Its live engine reported `await_post_hand_tasks+1061s`, although transport telemetry continued. Logs repeatedly refused add-on 4ffc85a0-77b0-4a71-9ea9-2093cb21c1de as no longer unresolved.

Read-only production receipts prove that accepted hands 8247587 and 8251566 froze the same add-on ID before backlog recovery. The earlier hand completed at 17:32:23. The add-on already records 276 applied and zero refunded. The later hand's consumer insists on resolved_at IS NULL before calling resolve_pending_addon, although that resolver already returns the authoritative stored result on replay. This redundant precondition turns successful prior delivery into a permanent hand barrier.

The change preserves the exact add-on ID, table lock, immutable hand payload and predecessor barrier. It admits the same row regardless of completion, then requires the resolver's applied/refunded result to be nonnegative and conserve the original amount. Missing, foreign-table and incomplete receipts still fail. It never adjusts balances, deletes receipts or sets hand completion outside the existing processor transaction.

Verification: the isolated PostgreSQL accounting suite passed, including 14 new real-processor/resolver scenarios. These reproduce the old refusal, prove full application, split refund and full refund replay without changing money, reject missing/foreign/hash-mismatched/incomplete/non-finite receipts, and exercise two accepted hands sharing one unresolved add-on. The predecessor barrier remains in force and only the first hand credits the stack. Stored null receipt components cannot be hidden by the resolver's legacy COALESCE.

The exact guarded migration applied to isolated PostgreSQL successfully. The first full-migration fixture lacked table_pending_addons, so its CREATE FUNCTION failed; adding that real schema dependency to the isolated fixture resolved the fixture failure. Production was not used as a DDL probe. Client tsc --noEmit exited 0. No production seat, buy-in or balance mutation was used for verification.

At 18:03 UTC, both public client origins served 4932f6f91ad9b08300cf20afbeb9576b6559770f and Docker ran the same immutable engine image, started 17:55:33. The reported table committed a further hand 8258809 at 18:01 but remains blocked behind 8251566; this is not proof of restored ongoing play. Live migration application and natural recovery must still be verified.

Production application succeeded at 18:09:08 UTC, catalog version 20260908180908 (the MCP assigns its application timestamp; the repository file uses the previously reserved 20260908175113). Live function MD5 is 0f9656e8ece4172db2988376c287d10c. No financial function was manually invoked.

Natural recovery is proven: hands 8251566 and 8258809 completed at 18:09:16.208 and 18:09:16.370. The browser then displayed hand 8261970 with an acting player and real raise/fold actions. Hands 8261970 and 8262288 completed their database obligations at 18:10:04 and 18:10:43. At 18:11 the oldest of six pending fleet receipts was only seconds old, instead of the earlier permanent backlog.

The first CI run failed the migration-applied gate because the static manifest omitted this existing function, although its live definition was verified. The branch adds a scoped manifest fragment, following schema-manifest.mjs, rather than editing the shared generated snapshot or weakening the check. The gate is re-run on that truthful catalog declaration.

Remaining latency is not declared fixed: an EXPLAIN ANALYZE of this table's predecessor read used the existing table/hand index, filtered 90 rows and took 5.037 ms, so an additional index is not justified as the root of the multi-second gap. The live tail still needs measurement beyond this recovered table.
