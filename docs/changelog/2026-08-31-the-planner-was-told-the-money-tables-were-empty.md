# 2026-08-31 - The planner was told the money tables were empty

## What was measured

Found while asking what was left to optimise, not while looking for it.
`pg_stat_user_tables`, before:

| table | size | planner thinks | autoanalyze_count |
|---|---|---|---|
| `wallet_transactions` | 963 MB | **330** | 0 |
| `chip_ledger` | 151 MB | **920** | 0 |
| `tournaments` | 113 MB | **80** | 0 |
| `ca_seat_stack_exits` | 15 MB | **7** | 0 |

A 963 MB table the planner believes holds 330 rows gets nested loops and
sequential scans for everything, and its indexes are never chosen - an index is
not worth it on a table with 330 rows. That is a platform-wide tax on every
money query. It is also a large part of why **1,461 indexes look "unused"**: the
planner will not pick an index for a table it thinks is empty.

## After ANALYZE

```
wallet_transactions      330  ->  2,484,700     (7,529x)
chip_ledger              920  ->    222,301       (242x)
tournaments               80  ->     52,646       (658x)
ca_seat_stack_exits        7  ->     40,872     (5,839x)
```

Measured on the seat-exit alarm, three consecutive runs:

```
5,242 ms (cold)  ->  720 ms  ->  692 ms      against 10,570 ms before
```

Roughly **15x in warm steady state**, on top of the rewrite in
`20260831142004`. The full chip integrity report went 12,866 ms -> 7,817 ms in
the same measurement.

The first reading after ANALYZE was 21,294 ms, which is a cold-cache artefact of
invalidating cached plans - recorded here because taking that single number as
the result would have said, wrongly, that ANALYZE made things worse.

## Why it drifted, and why a one-off ANALYZE is not the fix

Autovacuum is ON globally, and two tables are already tuned carefully by
somebody:

```
hand_history         analyze_threshold 2000, scale 0.0, insert_threshold 10000
wallet_transactions  analyze_threshold 1000, scale 0.0
```

The other three carried `(defaults)`. At the default analyze scale factor of
0.1, a table must change by **10% of its own size** before autoanalyze looks at
it - so on a growing append-heavy table the estimate is permanently stale, and
stale from whenever the table was small. `tournaments` was sitting on 9,769 dead
tuples with `autovacuum_count` 0.

So this extends the treatment the two tuned tables already have to the three
that were missed - threshold-based rather than scale-based, which is what makes
it hold as they grow.

## What the assertions check

Both halves. That every named table now carries a threshold-based setting and
that no planner estimate is still absurd; **and** that `autovacuum_enabled` was
not left `false` on any of them - a fat-fingered disable here would stop
vacuuming the ledger entirely, which is far worse than a stale estimate.

Applied as `20260831155133_the_planner_was_told_the_money_tables_were_empty`.

## Still open, and deliberately not done here

**1,461 never-scanned non-unique indexes, 1,352 MB.** Every one is maintained on
every INSERT and UPDATE. But that census was taken while the planner believed
these tables were nearly empty, so an unknown share of it is an artefact of the
very problem this migration fixes. The honest sequence is: let the corrected
statistics run for a few days, re-take the census, and only then drop in batches
- biggest and most write-heavy first, with the `CREATE INDEX` statements kept as
the rollback. Dropping 1,352 MB of indexes on evidence gathered under a lie
would be exactly the kind of confident mistake this estate keeps writing
changelogs about.
