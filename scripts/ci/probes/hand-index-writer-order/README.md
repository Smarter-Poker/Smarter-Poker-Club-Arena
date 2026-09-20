# Hand-index writer concurrency

The existing GitHub-hosted `accounting_postgres` job invokes this driver with its
installed PostgreSQL17 tools. Its command contract is:

```sh
PG_BIN=/usr/lib/postgresql/17/bin python3 scripts/ci/test-hand-index-writer-order.py \
  --migration supabase/migrations/20260914194928_hand_index_writers_share_a_canonical_order.sql \
  --output /tmp/hand-index-proof-unique
```

The output directory must not exist. The runner creates one private Unix
socket database, disables TCP, bounds connections and memory, requires 2 GiB
of free disk, and removes its cluster after success or failure. It neither
connects to production nor touches another owner's fixture. Results bind
the runner and migration hashes and name the actual PostgreSQL/OS versions.

`baseline.json` contains the four production definitions captured during the
investigation of operational alerts 76 and 79. All hashes were independently
rechecked on September 14 at 19:42 UTC. The private schema preserves the
actual index primary key and secondary indexes. A test-only gate allows two
real transactions to hold their first keys before competing for the next.

The small fixture's default sorted aggregation did not reproduce the defect.
The qualified probe selects PostgreSQL's legal hash-aggregation alternative
with `enable_sort=off` and `work_mem=32MB`; an unordered `DISTINCT` cannot rely
on either plan. The unchanged functions deadlock; the ordered candidate
completes both execution orders with every unique seat retained.

The projector implementation is real, but unrelated financial aggregates
are avoided through the Diamond branch, and per-hand facts return no rows.
The legacy trigger is exercised using a private UPDATE binding to supply
its NEW record. These are explicit index-concurrency limits, not full
financial, production-trigger-binding, Linux or installed release proof.
Do not reuse this result to close the separate per-hand-stat retention or
terminal-settlement deadlocks.
