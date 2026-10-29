# Tournament source identity cover

The sole production change adds `(id) INCLUDE(tournament_id,rake_record_id)` to the existing fee source table. The fixed UUID keys avoid reading the wide contract just to establish source/event identity. No source data, quality function, financial helper, existing index, trigger, generation or planner setting changes.

`actual-table-authority.json` freezes the root's production read-only catalog at 02:04 UTC October 29. The migration requires its full 15-column/default, five-constraint, 14-index, owner/ACL/RLS/policy and eight-trigger contract. Only generated RI trigger names and OID identities normalize for reproducible qualification. Complete raw trigger metadata and definitions remain byte-equal across the actual transaction. Source65 and the original generation and seal definitions remain unchanged.

Run the maintained private PostgreSQL 17 qualification:

```
python3 -B scripts/ci/test-tournament-source-identity-cover-postgres.py --pg-bin /path/to/pg17/bin --scratch /short/owned/ssd/path --output /owned/evidence/result.json
```

It reproduces the full source table schema, constraints and all old indexes with 5,000 wide contracts, including a 96KB contract. Actual source-trigger ABIs/catalog shape are present; their financial bodies are explicit inert adapters. It executes immutable installed28a and uninstalled541b full quality/query snapshots. Dense/sparse auto/custom/generic full ordered FOR bags remain equal. The orphan identity CTE naturally uses index-only scans in all six after plans; dense541b selected keys use index-only scans in auto/custom only. Sparse/generic tournament-key heap probes remain legitimate. Zero heap fetches depend on visibility-map state. VACUUM ANALYZE initializes the private fixture before CCI; no source statistics change after CCI. Fault bags run afterward, comparing with/without the cover through private rolled-back transactions.

Actual CCI runs outside the history transaction. The native test witnesses waiting for an old repeatable-read snapshot while a separate FK writer commits. It verifies valid-prefix resume, invalid-prefix refusal, atomic exact-history failure/success/replay, full table authority faults, NULL/wrong-event/foreign source bags and unchanged public/private function metadata. Generic protected-main CCI admission retains its existing 600-second build and 12-minute reserve. Production installation and whole Scope capacity remain separately unverified; no production latency or original financial producer qualification is claimed.
