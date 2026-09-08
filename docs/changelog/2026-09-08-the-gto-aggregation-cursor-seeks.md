# 2026-09-08 - the GTO aggregation cursor seeks instead of re-reading its own progress

## What was wrong

`fn_aggregate_gto_v31_next` folds `solved_spots_gold.strategy_matrix_v2` into
`gto_postflop_v31`, 10 rows a tick, since 2026-08-30. Nine days in it had done
**655,130 of 1,891,817** rows and was getting slower. Its keyset pagination was

```sql
s.solved_v2_at > last_at OR (s.solved_v2_at = last_at AND s.id > last_id)
```

which Postgres cannot use as an index start point. EXPLAIN ANALYZE at the live
cursor (03:40 UTC):

```
Index Scan using idx_solved_spots_gold_solved_v2_at
  Rows Removed by Filter: 655130
  Buffers: shared hit=611591        (~4.8 GB)
  Execution Time: 761 ms
```

Every batch re-read the entire prefix it had already processed, to return 25
rows - **O(n²) in its own progress**, on the largest table in the database
(80 GB, 75 GB of it TOAST), every tick, forever. That one index shows **21.7
billion tuples fetched across 66,083 scans**.

## The fix

A row-wise comparison, which is sargable, and a composite index in exactly the
cursor's order (`idx_ssg_v2_cursor (solved_v2_at, id) WHERE solved_v2_at IS NOT
NULL`, built CONCURRENTLY, valid 03:41 UTC):

```
Index Only Scan using idx_ssg_v2_cursor
  Index Cond: ROW(solved_v2_at, id) > ROW(last_at, last_id)
  Buffers: shared hit=9 read=3
  Execution Time: 0.082 ms
```

**761 ms -> 0.082 ms. 611,591 buffers -> 12.** And the cost stops growing with
progress. Nothing else in the function changed: same batch, same cursor row,
same aggregation, same restart safety.

## The constants were calibrated with the bug inside them

Every number in the driver's batch table was measured while each call also
paid that rescan, so "25 -> 9.06s, CANCELLED" was mostly the rescan. Re-measured
on the same RPC path (service_role, 8s `statement_timeout`) right after the fix:

| batch  | cold      | warm                | verdict                   |
| ------ | --------- | ------------------- | ------------------------- |
| 10     | 5.56s     | -                   | fits                      |
| **25** | **4.53s** | 1.15 / 1.30 / 1.38s | fits, 44% headroom cold   |
| 35     | -         | 1.57 / 1.64s        | fits warm; no cold sample |
| 50     | 8s+       | -                   | 57014, cancelled          |
| 100    | 8s+       | -                   | 57014, cancelled          |

`BATCH` 10 -> **25** (the largest with a _cold_ sample behind it; 35 is not
taken on warm samples alone - the same discipline the original 10 was chosen
by). `MAX_CALLS_PER_TICK` 4 -> **6**: the cap was no longer binding, because
four warm calls used 5.2s of the 12s budget and the driver then idled.
`TICK_BUDGET_MS` is unchanged and is the governor again - a cold tick
self-limits to two or three calls, since 6 x 4.5s is well past it.

Throughput: ~20-40 rows a tick -> ~150. The remaining ~1.23M rows go from the
driver's own estimate of "11-22 days" to under two. The three tests that
pinned the old constants now pin the constants themselves, with the new
measurement recorded beside them.

## Why finishing matters

The live deal path reads only `gto_postflop_compact` (30 MB) and
`gto_postflop_v31` (9.9 MB) - via `GtoPostflopLoader` and
`GtoPostflopV31Loader`. `solved_spots_gold` is walked by nothing else but this
aggregation. When V31 completes, that 80 GB - **57% of the 141 GB database** -
is cold reference data that can be archived off the primary, which is the
largest single saving left on this database.
