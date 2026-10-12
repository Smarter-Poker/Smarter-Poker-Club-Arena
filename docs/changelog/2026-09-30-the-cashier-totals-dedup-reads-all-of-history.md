# The cashier totals de-duplication reads all of history to answer one week

2026-09-30

## What was broken

`fn_cashier_statement_totals` timed out for real club admins.
`/hub/club-arena/clubs/:club/cashier/statements` printed **Unavailable For This
Range** where the four figures belong, and
`tests/e2e/production-cashier-statements.spec.ts:156` failed with "authorized
statement totals did not return a usable verdict", which is part of why
Post-Deploy E2E could not certify.

Measured from `pg_stat_statements` on production:

| metric                            | value      |
| --------------------------------- | ---------- |
| calls                             | 21         |
| mean                              | 3,482.0 ms |
| max                               | 7,968.7 ms |
| `authenticated` statement_timeout | 8,000 ms   |

12 of 16 calls in 24 hours answered HTTP 500 at ~8.07 s. The four 200s were the
unauthorized early return, so effectively every real admin request failed.

## What it was not

Three migrations on 2026-09-27 had already attacked this
(`cashier_receipt_totals_use_a_covered_club_time_range`,
`cashier_totals_match_receipt_omissions_before_the_movement_r`,
`cashier_movement_totals_use_a_covered_ledger_range`). They were right: they
built `idx_chip_tx_club_time_totals` and `idx_chip_ledger_cashier_totals_cover`,
and both branch scans are now index-only on exactly the columns the totals need.

So it was not a missing index, and it was not a sequential scan, a spilling sort
or a nested loop. It was also not a fat projection: a hand-written two-column
version of the receipt branch returns **identical** Buffers and Heap Fetches to
the full generated one, so the planner had already eliminated the 25 discarded
columns.

## The plan, read not assumed

`EXPLAIN (ANALYZE, BUFFERS)` of the generated totals SQL, club
`a41434bb-8d0c-400a-8f0d-e8b3d65afed4`, its default last-7-day range
(50,014 receipts + 27,031 movements = **77,045 entries**):

```
HashAggregate                                                  6,038.8 ms
  CTE omitted_movements  ....................................  2,756.1 ms
    Index Scan using ux_chip_transactions_idempotency_key
      rows=8   Rows Removed by Filter: 1146
      Buffers: shared hit=165 read=828  .....................  2,709.1 ms
  Index Only Scan idx_chip_tx_club_time_totals  rows=50,026
      Heap Fetches: 3,813   Buffers: hit=3257 read=810  .....  3,036.0 ms
  Index Only Scan idx_chip_ledger_cashier_totals_cover  rows=27,044
      Heap Fetches: 1,505   Buffers: hit=2187 read=0  .......    113.0 ms
```

### The defect: the dedup arm is O(all time), not O(range)

The `omitted_movements` CTE stops a `chip_ledger` movement being counted twice
when a `chip_transactions` receipt already mirrors it. Its first arm filters
`represented.club_id` and `represented.created_at` - but the only index able to
serve `metadata ? 'idempotency_key'` was `ux_chip_transactions_idempotency_key`,
keyed on the extracted key **alone**, carrying neither column.

So the planner scanned that index in full - every idempotent receipt ever
written on the platform, for every club - and visited the heap once per entry to
evaluate club and range. Note the plan line has **no Index Cond at all**:

```
Index Scan using ux_chip_transactions_idempotency_key
  Filter: ((club_id = '...') AND (created_at >= ...) AND (created_at < ...))
  Rows Removed by Filter: 1146          <- 1,154 scanned to keep 8
```

1,154 entries, 1,146 discarded, **828 cold random heap reads**, 2,709 ms - about
45% of the cold call, to return zero rows. A one-day range cost exactly what a
ninety-two-day range cost, and the cost grew with total platform history rather
than with what the admin asked for. 1,154 such receipts exist today; every
idempotent receipt adds one, forever.

## The fix

One partial index, built `CONCURRENTLY` because `chip_transactions` is on the
live money path (a plain `CREATE INDEX` holds SHARE and blocks every INSERT for
the whole build - CLAUDE.md section 2 rule 7):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_tx_club_time_idempotency_key
  ON public.chip_transactions (club_id, created_at, ((metadata ->> 'idempotency_key')))
  WHERE metadata ? 'idempotency_key';
```

`club_id` and `created_at` lead so the arm range-scans; the extracted key is
carried so it stays index-only and visits no heap page at all. It indexes 1,154
of 1,050,406 rows (~0.1%), so it costs tens of kilobytes.

Nothing else moves. The CTE's SQL, its semantics and every row it omits are
untouched, so the totals are identical - only the access path changes. No
pre-aggregation, no cache, no cron, no sweep, no back-fill (CLAUDE.md 10.11,
10.12), and no `statement_timeout` touched (CLAUDE.md section 2).

Migration `20260930183001_cashier_statement_totals_dedup_is_range_bounded.sql`.
Law `tests/the-cashier-totals-dedup-is-bounded-by-its-range.law.test.ts` pins
both halves - the index AND the three CTE predicates that let it be
range-scanned - because either failing alone is silent: the plan reverts,
nothing goes red, and the timeout comes back.

## What this does NOT fix, stated plainly

The residual cost is the two branch scans' **heap fetches**: 3,947 on
`chip_transactions` and 1,484 on `chip_ledger` for the default range. Those are
visibility-map misses on recently written pages. They are not query waste and no
index or rewrite removes them - the scans are already index-only on covering
indexes, and the rows genuinely are recent.

The measurements that show it, all on the _same_ index:

| range                           | rows   | heap fetches | cold reads       | time               |
| ------------------------------- | ------ | ------------ | ---------------- | ------------------ |
| `chip_ledger`, an OLDER week    | 75,796 | **7**        | 968 (sequential) | **62.8 ms**        |
| `chip_ledger`, the CURRENT week | 27,103 | **1,484**    | 742 (random)     | up to **3,674 ms** |

A sequential index-leaf read costs ~0.065 ms on this storage; a random heap
fetch costs ~1-5 ms. That ratio, not row count, is the whole cost model:

- warm, the identical work is **58-170 ms**;
- cold, it is **6,038-7,729 ms**, and which one you get depends on what else
  evicted your pages from the 8 GB buffer pool.

Removing the dedup CTE entirely still measured **7,729 ms** on a cold run, so
this migration alone is **not** a guarantee that every call fits in 8 s. It
removes ~828 cold reads and 2,709 ms per call and it stops an unbounded term
from growing - that is real, and it is what was actually broken - but the
default view's floor is still thousands of random heap fetches.

Two things were investigated and deliberately **not** shipped:

1. **Autovacuum insert thresholds** (`chip_transactions` 4,000;
   `chip_ledger` 60,000). Lowering them would shrink the not-all-visible window.
   But the visibility map is already 98.2% complete on both tables, and
   `chip_ledger` showed 7,464 pages still not-all-visible three minutes after an
   autovacuum with only 698 inserts since - which that model does not explain.
   `VACUUM` cannot be run through the Supabase MCP (it wraps every call in a
   transaction), so the lever could not be measured before or after. Shipping a
   tuning change to two hot money tables on an unverified model would be exactly
   the confident answer CLAUDE.md 10.86 rule 1 forbids. It needs a
   `VACUUM`-capable session; the numbers above are the starting point.
2. **Forcing parallelism** in the function. The planner already parallelises the
   same scans at higher row counts (4 workers launched on a 615k-row range), and
   the cost is I/O-latency-bound, so dividing it across workers should help. It
   could not be measured cold cleanly - every attempt ran against a warmed
   buffer pool - so it is recorded here rather than shipped on a hunch.

### The ceiling, for whoever picks this up

The widest range on the biggest club (`2a1132b9-...`, 332,264 receipts +
282,614 movements = **614,878 entries** over 92 days) measured **9,997 ms** even
with 4 parallel workers and a minimal two-column aggregate. 8,213 of its heap
fetches were in its last 3 days. That range cannot be served inside 8 s by any
index, and the honest options are a narrower maximum range or pre-aggregation
written by the live path in the same transaction as the money it summarises.
Neither is in scope here and neither should be guessed at.
