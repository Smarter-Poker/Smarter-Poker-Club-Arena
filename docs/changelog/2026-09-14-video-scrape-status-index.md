# The latest video report should not scan unrelated audit history

The workers video status route returned a database statement timeout while looking for its latest scrape report. Production has about 1.4 million audit rows and 4GB of table/index storage. Its existing timestamp index cannot efficiently answer the table-name/action predicate; the actual plan selected a parallel sequential scan and sort.

The partial index covers exactly video-library scrape reports in descending creation order. It preserves audit history, result semantics and permissions. The online build allows concurrent audit writers, with bounded lock and statement deadlines. A same-name index with a different definition is refused instead of silently accepted.

Twelve native PostgreSQL 17 checks cover the original broad plan, real held and concurrent writing transactions during index creation, the indexed query plan, exact result parity, unchanged rows, replay and conflicting-index refusal. No production report, game or financial row is created or changed by this migration.

Live index validity, query plan and the authenticated workers status request are separate release requirements; the upstream YouTube metadata refusal remains a separate incident.

The migration connector wraps SQL in a transaction, so it refused the initial concurrent-build attempt with 25001 before any index was created. The reviewed online statement runs through an existing direct autocommit connection; the ledger migration independently verifies its exact valid definition. Neither the write-blocking plain build nor a transaction-control workaround is used.
