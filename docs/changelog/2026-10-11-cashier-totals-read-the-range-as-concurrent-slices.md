# Cashier totals read the range as concurrent slices

## The defect

`fn_cashier_statement_totals` sometimes returned HTTP 500 "canceling statement
due to statement timeout" to signed-in owners and admins. The authenticated
role's limit is 8 s. pg_stat_statements on 2026-10-11 showed 235 calls, a mean
of 2.56 s and a max of 6.97 s. In the edge logs, every Post-Deploy E2E call took
3.1-4.7 s: each run uses a fresh Shark Club admin with the default "last 7 days"
range. The call at 21:42:59 UTC took 8.09 s and returned 500 while
`sp_prune_hand_history` was running a 26.5 s job. That call failed
`tests/e2e/production-cashier-statements.spec.ts` in run 38176048197.

## The cause, measured on production

The aggregate was already set-based. #6615 (`20261010011934`) makes the
default owner total read one directional range per source. Both reads are
index-only, on `idx_chip_tx_club_time_totals` and
`idx_chip_ledger_cashier_direction_totals`. The time went to cold page reads:

| Shark Club owner, last 7 days (395,000 rows) | time     | buffers                     |
| -------------------------------------------- | -------- | --------------------------- |
| warm                                         | 158 ms   | 23,702 hit                  |
| cold                                         | 3,794 ms | 16,633 hit + **7,059 read** |

The 7,059 reads are the leaf pages of the two covering indexes for that week:
4,343 on chip_transactions and 2,761 on chip_ledger. Those pages were created
by page splits as the rows arrived, so they are scattered on disk. A btree range
scan reads them strictly in order, because each leaf points to the next one:

- serial, cold: 1,799 pages in 1,060 ms (0.59 ms a page);
- one parallel index scan with **seven** participants, cold: 2,462 pages in
  1,592 ms (0.65 ms a page). A parallel btree scan hands out the same chain in
  order, so extra workers wait on it and do not read ahead.

So the plan read about 7,000 random pages through at most two chains, one per
source. Any disk contention, such as the hourly prune, pushed a 3.8 s total past
8 s.

## The fix

Migration `20261011225840_cashier_totals_read_the_range_as_concurrent_slices`
changes only the default owner aggregate: totals mode, scope `all`, no
filter. In that aggregate, each source range is cut into at most 16
consecutive slices of at least 12 hours. The bounds go in `$20`. The first
bound is `p_from`, the last is `p_to`, and they strictly increase, so the
slices cover `[p_from, p_to)` exactly with no gaps or overlaps. Each slice is
its own index range scan, so a Parallel Append reads several chains at once.
For that one statement the function allows up to six workers instead of the
server's two, then restores the setting.

- Five cold one-day slices with four participants read 3,396 pages in 800 ms
  (0.24 ms a page, against 0.62 ms serially).
- The production plan for Shark Club's week is Parallel Append with 5 workers
  planned and 5 launched. Each slice's bounds are folded into its Index Cond.
  The warm total went from 131 ms to 102 ms for 7 days and from 292 ms to
  180 ms for 92 days.

Everything else is byte-identical to #6615, and the law test checks this: the
omitted-mirror set `$19`, the NaN arithmetic, the totals wrapper, and every
filtered, downline, self, page and export path. No index, timeout, cache, cron
or retry was added. Horses and humans are read by the same predicates.

I tried slicing the downline and self totals too and dropped it. Warm, it
added about 100 ms of planning and worker start-up to small calls.

## Equivalence proof

I ran one Supabase MCP call containing a single DO block that ends in RAISE
EXCEPTION. It created the new body in `pg_temp` and compared its
(direction, amount, count) rows against the live function. Result: 120 cases,
80 distinct callers, 0 mismatches. The cases were:

- 10 real owner/admin "all" callers, each over 4 hours, 1, 7, 30 and 92 days;
- 25 agents (downline) and 25 players (self), last 7 days;
- 20 synthetic "all" viewers in the three busiest clubs.

## Still open

A large downline over 30 days is also slow when cold: 11.5 s measured for a
23-member Shark Club downline. That path is a different problem. It reads its
ledger rows through the non-covering `idx_chip_ledger_club_{from,to}_created`
indexes, so every row is a random heap fetch. It needs its own fix and is not
part of this change.

## Coordination

Open PR #6676 also rewrites `fn_cashier_statement_rows`. It is a semantic
change (mirrored legs, receipt side split) and was already in conflict. Its
pre-image guard pins #6615's body, so it will have to rebase onto this one and
carry the slicing forward in the same commit.
