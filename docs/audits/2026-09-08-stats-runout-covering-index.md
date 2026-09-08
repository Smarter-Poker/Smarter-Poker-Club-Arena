# Seven-Day Runout Audit Access Path

The first narrowed showdown audit still took 95.27 seconds. Its seven-day EV
candidate scan uses an all-in index led by user_id even though the audit has no
user filter. PostgreSQL estimated 389,962 index matches, heap reads and filtering
to 42,733 candidates (total plan cost 243016.34). A previously recorded candidate
count alone took 68.60 seconds. The hand-facts heap is 2,132 MB, about 5.6M rows.

A partial covering index now leads with played_at, includes hand_id and
all_in_equity, and uses the exact existing was_all_in / went_to_showdown /
non-river predicate. It does not change the audit query, user facts, financial
records or access grants. PostgreSQL maintains membership on subsequent writes.

## Build and proof

The direct database endpoint was verified with a read-only connection before
building. The build used the companion single CREATE INDEX CONCURRENTLY
statement, outside a transaction. Per-session limits were statement_timeout
600000ms, lock_timeout 5000ms, maintenance_work_mem 32768kB and no parallel
maintenance workers. No role/global settings or cron schedule changed.

Production build: 21:30:46.092 to 21:31:55.315 UTC, exit 0 (69.39 seconds).
Catalog: idx_ca_hand_facts_runout_time_cover is valid and ready, size 13 MB,
with the expected columns and predicate. The guarded migration was then
applied through Supabase. It refuses a blocking fresh build on a heap over
64 MB and rejects an invalid or differently defined same-name index.

The actual migration and candidate equivalence ran against 20,000 isolated
rows. PostgreSQL chose an Index Only Scan; the result retained all 39 eligible
rows. The full existing PostgreSQL suite passes with the probe integrated
(70.28 seconds). The first integration check incorrectly expected the driver
to print intermediate EXPLAIN rows; the plan assertion now runs inside SQL so
both the psql and node-pg harness verify the plan itself.

The live planner also selects Index Only Scan, estimated cost 1244.13 versus
243016.34 before. A five-second bounded ANALYZE probe timed out; no faster
execution claim follows from estimated cost. About 91.57% of heap pages were
all-visible, leaving some heap visits necessary. No manual VACUUM was added.
The next ordinary scheduled audit and live hand-gap sampling must establish
runtime effect. The broad delay incident remains open.

Reference: https://www.postgresql.org/docs/17/sql-createindex.html
