# The hand-history prune resumes where it left off (2026-10-26)

Lease follow-ups, phase 4 of 5: back-office work competing with play. This
entry is the first and largest item, the retention prune.

## What was measured

`sp_prune_hand_history_10m` runs `sp_prune_hand_history(5000)` every 30
seconds with a 20 second work budget and a 30 second statement timeout. On
production, 24 hours to 2026-10-26 13:00 UTC (`cron.job_run_details`):

| measure                        | value                              |
| ------------------------------ | ---------------------------------- |
| runs                           | 2,693                              |
| median run                     | 30.1 s (budget 20 s, timeout 30 s) |
| p95 run                        | 37.9 s                             |
| share of the day spent running | 90.4%                              |
| timeouts                       | 3                                  |

`pg_stat_statements` since its reset on 2026-10-04: 221 hours of database
time, 7.0% of everything the database did in 22 days, the fourth largest
consumer behind only the engine's own hand RPCs. `hand_history` holds 10.4
million rows (52 GB with indexes) at 1.1 to 1.5 million hands a day since
launch week, and the pass was six hours behind its eight-day boundary.

## The cause, read from the plan

`EXPLAIN ANALYZE` of the pass's own candidate query, 2026-10-26 13:27 UTC:

```
Index Scan Backward using idx_hand_history_created on hand_history hh
  Index Cond: (created_at < (now() - '8 days'::interval))
  Rows Removed by Filter: 219000
Execution Time: 7218.996 ms
```

to choose 250 rows. The candidate set is `ORDER BY created_at LIMIT 250`, so
every round starts at the oldest row and walks forward, and about 219,000 rows
older than the boundary are retained on purpose: roughly 210,000 Diamond Arena
cash hands from 2026-10-04 onward that have no `cash_hand_provenance_receipts`
row (the cash readiness guard keeps a receipt-less cash hand as original
evidence; 290 of a 300-row sample from 2026-10-07 were exactly that, and all
145 receipt-less hands in a ten-minute sample from 2026-10-25 were Diamond
Arena tables), plus tournament hands whose event is not yet settled. Every
round re-evaluated every one of them before reaching the first prunable row:
seven of the ten seconds a round took, 120 rounds an hour, for rows whose
answer cannot change between rounds.

## The fix

Migration `20261026133101_the_hand_history_prune_resumes_where_it_left_off`
gives the pass a cursor, `smarter_private.hand_history_prune_cursor` (one row,
RLS on, no browser or service role grant, no foreign key):

- the candidate scan starts after the newest `created_at` the pass has already
  examined, so both bounds sit on `idx_hand_history_created` and a retained
  row is evaluated once per pass instead of once per round;
- a round that finds nothing between the cursor and the retention boundary
  parks the cursor at the boundary;
- a pass lasts at most 60 minutes; the next run after that starts over from
  the oldest row, so a hand whose guard has since released (its tournament
  settled, its accounting accepted) is pruned within the hour;
- the cursor is written in the same transaction as the deletes; a cancelled
  run rolls both back together, exactly as before.

Nothing about which hands prune changes. The migration reads the live
definition, pins its md5 (`3f42f51cbc26e7af58fe54ed1fa11a44`), proves each of
its eight anchors unique, splices the additions in, and refuses to commit
unless the result still carries the owner's `horse_retention_days` config
read, `FOR UPDATE SKIP LOCKED`, and the F06 and restoration-case guards.

The same production query with the cursor's lower bound added, measured the
same way: `Index Cond: (created_at < ... AND created_at > ...)`, `Rows Removed
by Filter: 208`, `Execution Time: 295.022 ms` for the same 250 rows. A round
goes from 7.2 s to 0.3 s. On a scratch PostgreSQL with the installed body
(byte-identical, same md5) and the migration applied: a fixture of 300
retained, 500 prunable and 200 not-yet-aged hands pruned the 500 in one run
with the retained block read once, the next two runs read nothing, the
boundary moving forward pruned the newly aged rows without a restart, a hand
whose guard released was pruned on the next pass, a frozen platform left the
cursor untouched, and a hand with a person in it was marked `has_human` and
skipped as before.

## Pinned

`tests/the-hand-prune-resumes-where-it-left-off.law.test.ts` requires the
installing migration's preimage pin, anchor checks and post-install check; the
lower bound beside the age bound; the 60-minute pass; the park-at-boundary and
advance-only-to-examined rules; the same-transaction cursor write; the
surviving guards; the private cursor table; and that no later full rewrite of
the pruner drops the cursor.

## Found on the way, not changed here

- **Diamond Arena hands are never pruned.** Every Diamond Arena cash hand
  lacks a cash provenance receipt, so the cash readiness guard retains it for
  ever: about 210,000 rows today and roughly 30,000 more a day (2.7% of
  horse-only cash hands), about 150 MB a day of a table that is otherwise held
  to eight days. Retention is the owner's decision (CLAUDE.md 10.5). The
  cursor makes the cost of carrying them a once-an-hour scan instead of a
  continuous one, but it does not make them go away.
- Other back-office work during play, measured from the same 7 days of
  `cron.job_run_details` and read in the next steps of this phase:
  `union-weekly-rakeback-close` every 5 minutes at 78 s average (p95 191 s,
  26% of the day); `rake-bbj-invariant-audit-hourly` 113 s average;
  `club-rake-rollup-catchup` 103 s average hourly;
  `ca-pay-backed-payout-shortfalls-hourly` 70 s average;
  `sp-daily-metrics-snapshot` up to 600 s.
- The engine's event loop: p99 delay median 163 ms, p95 640 ms, max 1.5 s over
  24 hours, with the equity governor at 1.0 and the equity worker pool 26%
  busy, so the main thread's load is not Monte Carlo. Also for the next steps
  of this phase.
