# 2026-09-26 - The period recompute outlives its server

## Verdict on "the rakeback settler is dead"

The earlier claim cited a table that does not exist
(`public.rakeback_settler.high_water_mark`). Re-derived from real objects:

- Cursor: `public.daemon_state` row `daemon='rakeback_settler'` -
  `high_water_mark = 2026-09-22 10:37:05.499207+00`, `updated_at = 2026-09-22 10:37:12`.
- Backlog: 234,593 `rake_records` with `rake_amount > 0` after the cursor
  (213,067 cash), newest 2026-09-26 02:22.
- Engine: build `778075b4`, `[RakebackSettler] Starting (interval: 30m)` at
  01:59:27 UTC, and every cycle since logs
  `Acknowledged 986 source records; confirmed 0/46 period rows ... (failures: 46)`
  followed by `fn_rakeback_recompute_periods failed for 2a1132b9... 2026-09-21: supabase_timeout`
  and `period_recompute_failures_hold_cursor`.

Of the three outcomes (not running / running and refusing / running and
succeeding but unable to advance) it is the THIRD. The settler runs, the source
batch succeeds (`fn_credit_agent_commissions_batch` returns receipts), and the
period recompute COMMITS on the server - `accounting_period_recompute_requests`
for Deep Stack Society week 2026-09-21 has `attempts = 531`,
`attempted_at = 02:02:26` - but the client abandoned it at 15 s (02:00:24), so
the settler counted a failure and held the cursor. The work was done and thrown
away every cycle for 3.6 days.

## Cause

`fn_rakeback_recompute_periods` rebuilds a whole (club, week) book from source
and declares `SET statement_timeout='300s'`. It was called through the ordinary
15 s engine client. Deep Stack Society's week 2026-09-21 holds 170,161 of the
week's 268,277 rake_records; one recompute took 137 s (pg_stat_statements
max_exec_time 137,213 ms). This is the first full week under the 2026-09-17
accrual cutover (week 09-14 returns `historical_week_before_observed_source_cutover`
instantly), and it crossed 15 s about a day in. Same defect class as the
2026-09-17 source-retry stall, one call further down the same cycle.

## Fix

- `cashAccountingBatchBudget.ts`: `PERIOD_RECOMPUTE_SERVER_BUDGET_MS = 300_000`
  and `periodRecomputeClientTimeoutMs()` = server budget + 15 s transport margin.
- `supabase/client.ts`: `accountingPeriodSupabase`, a bounded client built from
  that derivation (same pattern as `maintenanceSupabase`).
- `RakebackSettlerService`: the recompute RPC uses it. Nothing else changes; the
  cursor-hold on a genuine failure stays.
- Law: `tests/the-period-recompute-outlives-its-server.law.test.ts` reads the
  latest SQL definition's declared timeout, requires the client to outlive it,
  and forbids the recompute going through the 15 s client. Negative proofs:
  reverting the call to `supabase.rpc` fails test 4; setting the budget to
  15,000 fails test 1.

No money moved and none needs to: the recompute rebuilds from source and the
source receipts are idempotent, so once the engine carrying this runs, the next
cycle hears the verdict and advances.

## Remaining risk, stated

The recompute is O(week). At 137 s for 268k week records, linear growth reaches
the 300 s server budget near ~590k records in one week; current inflow is
~64k/day (~450k/week). It fits, with less than 2x headroom. If a week outgrows it
the server's own statement-timeout error will now reach the settler as a real
failure instead of a fake one, which is the correct signal - but the cost of the
recompute itself is the next thing to fix, not this deadline.

Catch-up cost: each 1,000-row page carries one ~140 s recompute for the busy
club, so the 234,593-row backlog drains in roughly ten hours (about 25,000
rows/hour against ~2,700/hour arriving) once this engine is live.
