# 2026-09-30 - The rake rollup's budget is its own statement, and its day query reads one day

## What was broken

pg_cron job `union-rake-rollup-catchup` (jobid 366, `55 * * * *`) failed on every
run from **2026-09-29T00:55Z**: 54 consecutive failures by 22:55Z on the 30th,
each lasting exactly **00:02:00.00x**, each `canceling statement due to statement
timeout` inside the `INSERT INTO union_rake_paid_daily_user` of
`fn_union_rake_rollup_refresh_day`. The last success was 2026-09-28T23:55Z
(8.3 s). `union_rake_paid_daily_user` and `union_rake_rollup_days` both stopped at
**2026-09-27**.

## Two causes, read from rows

1. **The 600 s budget never applied.** The command called
   `set_config('statement_timeout', '600s', true)` inside its `DO` block. The
   statement timer is armed when the top-level statement starts, and the `DO` is
   that statement, so the job ran under the `postgres` role's
   `statement_timeout=2min` (`pg_roles.rolconfig`). The 2:00 signature on every
   failure is that number. `midway-close-once-20260929d` issues its `SET` as its
   own top-level statement and ran 45 minutes under it.

2. **Why a pass crossed two minutes at all.** The cash leg split each hand's
   rake with `SUM(value) OVER (PARTITION BY r.id)`. To feed that window in id
   order the planner chose `Index Scan using rake_records_pkey` with
   `created_at` as a _filter_: it walked every rake record ever written to find
   one day's 46,255. Measured on production, read-only and rolled back
   (single-call `DO ... RAISE EXCEPTION 'PROBE ...'`):

   | piece (day 2026-09-28)                          | time                              |
   | ----------------------------------------------- | --------------------------------- |
   | the day query as written                        | > 55 s (cancelled)                |
   | the same query, hand total from a `LATERAL SUM` | **1.1 s** (516 users, 151,868.24) |
   | cash leg alone                                  | 0.8 s                             |
   | tournament leg alone                            | 0.4 s warm, 11.3 s cold           |
   | `fn_union_rake_stale_days`                      | 1.1 s                             |

   Equivalence: the rewritten query recomputed 2026-09-27 and reproduced all
   **500** stored `union_rake_paid_daily_user` rows exactly (0 differences).

## The fix (migration `20260930232545`, applied 2026-09-30 23:25 UTC)

- The job's command is now `SET statement_timeout = '600s';` followed by the
  `DO`. The advisory lock became `pg_try_advisory_xact_lock`, released with the
  pass's transaction. Schedule unchanged.
- `fn_union_rake_rollup_refresh_day`: hand total from a `LATERAL SUM` over the
  same `jsonb_each_text` rows. Same number, no ordering, the day index is used.
- `fn_union_rake_rollup_catchup`: stops **starting** new days once its
  top-level statement is 240 s old and reports `out_of_budget`. The days it
  rolled commit; the rest stay stale in `union_rake_rollup_days` and the next
  hourly run resumes from that record.
- **Timeout derived:** worst day 11.3 s cold, at most 8 days per union and one
  union today, so about 90 s cold worst case; new days stop at 240 s; 600 s
  leaves more than 2x headroom over that, and is the budget
  `fn_ca_rake_rollup_writer_silent` already describes.

## What this is not

No new job, catch-up, backfill or healer. This is the existing reporting
rollup whose schedule is the product (CLAUDE.md 10.12). No rows were
hand-written: the stale days are brought current by the job itself on its own
schedule. Horses are rolled up exactly as humans; there is no `is_horse`
anywhere in these functions.

## Pinned

`tests/the-rake-rollup-budget-is-its-own-statement.law.test.ts` fails if the
timeout moves back inside the `DO`, if the `PARTITION BY r.id` window returns,
or if the per-pass budget is removed.
