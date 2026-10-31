# Original cash refusal scope/time access

The actual production catalogs are the source of `authority.json` and the two
function images. `guard-select.sql` captures the same stable contract; only five
observational pg_class counters are excluded. The original six indexes, both
schemas/ACL/RLS, 10 raw triggers and five deduplicated trigger owners remain.

The single new Btree key is bounded without restricting legal JSON: unknown
uses seven bytes; club/union with a 36-octet UUID ID uses at most 42 bytes; other
values index NULL. Timestamp/UUID keys are fixed width. No JSON INCLUDE or
volatility helper is introduced. The index and a separate bounded ANALYZE of only scope, earned_at and id are
installed before the original owner changes. Real expression/column statistics
and exact collection history are required. A valid exact interrupted index prefix may resume;
invalid or different prefixes refuse and require explicitly qualified recovery.

The source preserves the full original validation and final aggregation/return
bytes. Finite range and exact ±infinity branches are disjoint and retain all
blocked-work duplicate rows. Native semantic proofs include long/missing/null/
unknown scopes, time edges, duplicate receipts and invalid scope arguments.
Natural plans show selector AND clock conditions; no planner flags or index-only
access claim is involved.

`reader-before.sql`, `reader-index.sql`, `reader-statistics.sql` and `reader-function.sql` are distinct
pure catalog states. Their success does not certify full original225 capacity,
payments or a closed book. Root is the sole production installer/DB writer.
