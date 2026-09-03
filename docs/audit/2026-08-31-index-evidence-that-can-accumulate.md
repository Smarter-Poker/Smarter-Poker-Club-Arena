# 2026-08-31 — The Unused-Index Evidence Could Never Arrive

## What I was asked to do, and why I did not do it

The performance advisor reports **~1,129 unused indexes holding about 1.4 GB**,
concentrated exactly where writes are hottest — `vip_points_ledger` (415 MB),
`solved_spots_gold` (298 MB), `wallet_transactions` (166 MB). Every one is
maintained on every insert to tables that take a write on every hand. Dropping
them is the largest single optimisation available here.

**Not one index was dropped.** The evidence does not support it, and this audit
is about why the evidence could not arrive.

## The statistics are ten hours old

`pg_stat_user_indexes.idx_scan` is cumulative since the last statistics reset.
Verified, rather than assumed:

|                                  |                                               |
| -------------------------------- | --------------------------------------------- |
| `pg_stat_database.stats_reset`   | NULL (never explicitly reset)                 |
| `pg_postmaster_start_time()`     | 2026-08-31 01:15:48Z — **10h24m before this** |
| `hand_history` inserts in window | 105,619                                       |
| documented insert rate           | ~221,000/day                                  |

105,619 ÷ 221,000 ≈ **0.478 days ≈ 11.5 hours**, matching the uptime. The
counters were wiped by that restart.

So `idx_scan = 0` means _"not used in the last ten hours"_ and nothing more.
Every index serving a nightly, weekly, or monthly job reads as unused. Dropping
on that basis would break reporting paths, and the damage would surface days
later, far from the cause.

## The mechanism built to solve this could never reach a verdict

`20260826_index_usage_snapshots_so_unused_can_be_proven.sql` got the hard part
right. It refused to trust `idx_scan`, built a snapshot table, and required
_"two snapshots spanning the requested days with **no postmaster restart**
between them"_.

Correct — and, in this environment, unsatisfiable. Measured five days on:

```
captures ................. 6
distinct server epochs ... 6      <- one capture per epoch, every time
uninterrupted history .... 0.000 days in EVERY epoch
```

The snapshot ran **daily** (`pg_cron` job 140, `41 4 * * *`). This server also
restarts **about daily** — 01:15, 02:15, 04:32, 04:33 on consecutive days — so
every 04:41 capture landed in a fresh epoch and the next restart arrived before
the following one. **Two snapshots have never once shared a `postmaster_start`**,
so `fn_truly_unused_indexes(n)` returned nothing for any `n > 0`, and always
would have.

It is not broken. It is fail-safe machinery that can never reach a verdict — a
permanent abstention wearing the costume of a safeguard.

## Two changes, and not one dropped index

1. **Snapshot faster than the server restarts** — every two hours instead of
   daily, so a ~21-hour epoch holds ~10 captures and yields a real delta.
2. **Measure across epochs, not within one** — a restart resets the counter, so
   readings cannot be _subtracted_ across it, but the deltas either side can be
   _added_. Usage is the sum of per-epoch deltas; the evidence window is the sum
   of per-epoch spans. Waiting for seven uninterrupted days on a box that
   reboots nightly is waiting forever.

The fail-closed property is **kept**: an index must be watched for `p_min_days`
before it can be called dead, so a newly created index is never mistaken for one.

### Storage

3,076 indexes × 12 captures/day ≈ **448 MB in sixty days** — not a price a
diagnostic gets to charge on a database already carrying 3.6 GB of hand history.
Only the first and last capture of a _finished_ epoch carry delta information,
so `fn_prune_index_usage_snapshots` collapses the rest daily: ~2 rows per index
per epoch, roughly **45 MB** at sixty days. The epoch still in progress is never
pruned — its latest capture is still moving.

## Verified against production

| check                               | result                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `fn_truly_unused_indexes(7)`        | **0 rows** — correctly refuses (0.294 days of evidence)                                |
| `fn_truly_unused_indexes(0)`        | **1,150 rows** — the machinery reaches a verdict when the bar is removed               |
| agreement with the advisor's ~1,129 | consistent — same population                                                           |
| snapshot schedule                   | `41 */2 * * *`                                                                         |
| prune schedule                      | `17 5 * * *`                                                                           |
| prune run on current data           | deleted **0** — every finished epoch has one capture, which is both its first and last |

## A defect found by running it, not by reading it

The first revision raised, on **every** call:

```
Returned type numeric does not match expected type bigint in column 5
```

`sum(bigint)` returns `NUMERIC`, and the `RETURNS TABLE` column is `bigint`.
plpgsql does not check a `RETURN QUERY`'s shape until the query actually runs,
so `CREATE FUNCTION` accepted it happily and nothing complained until it was
called. Fixed with an explicit cast, and the migration now **calls** the
function as its own assertion rather than merely creating it.

## What happens next

Nothing, for about a week. The captures accumulate on their own. When
`fn_truly_unused_indexes(7)` first returns rows, that list will be the first
evidence-backed drop candidate set this database has ever produced — and it
should still be read against the calendar, because a monthly settlement index
needs thirty days of silence, not seven.
