# The Hourly Audits Stop Holding The Hot Tables (2026-10-22)

Migration `20261022062934_the_hourly_audits_read_only_what_changed_since_they_last_loo.sql`.

## What Was Wrong

Several pg_cron integrity nets ran for minutes every hour, holding AccessShare
locks on `clubs`, `tables`, `hand_history` and the rake tables while they did.
Measured from `cron.job_run_details` over six hours to 04:10 UTC:

| Job                                         | Schedule | Avg   | Max   |
| ------------------------------------------- | -------- | ----- | ----- |
| 155 `rake-bbj-invariant-audit-hourly`       | :38      | 213 s | 265 s |
| 128 `club-rake-rollup-catchup`              | :25      | 157 s | 217 s |
| 233 `ca-conservation-sweep-hourly`          | :52      | 99 s  | 109 s |
| 156 `rake-attribution-drift-audit-hourly`   | :47      | 97 s  | 134 s |
| 123 `union-integrity-sweep`                 | :35      | 87 s  | 129 s |

Every probe was a single read-only `DO` block that ended in `RAISE`, so nothing
was kept. What each run was actually doing:

- **155.** The invariants themselves take 11 s. The rest is
  `fn_bbj_reconcile` on the union pool, whose cumulative journal is 5.0M
  ledger legs. Its first call in a cron session is planned with the pool and
  the opening timestamp as values, and for the rare-label branch the planner
  chose a `created_at` range scan of every BBJ leg since 2026-09-04 (2.36M rows
  removed by filter): 60-112 s. The generic plan of the same statement uses
  the pool's own partial indexes: 5 s.
- **156.** `fn_rake_attribution_drift` is `LANGUAGE sql SECURITY DEFINER`, so
  it is never inlined and its window arrives as a parameter. The planner
  priced a million hands and hash-joined all 9.2M `rake_attributions` rows:
  105 s for 9,000 hands. Planned with the window's value: 0.2 s.
- **128.** `fn_club_table_daily_catchup(2)` recounted each day's contribution
  keys (7-20 s a day) and then rebuilt yesterday on every run regardless
  (over 100 s): 24 rebuilds a day of a day that stopped changing at midnight.
  The recount decided nothing any more: since the rollups moved to
  `ca_club_data_fact`, `source_rows` is the facts' per-table maximum, so
  stored and counted never agree (557,947 against 714,953 for 2026-10-21).
- **233.** `fn_bbj_promo_bank_check` read `bbj_contributions` (3.4M rows) three
  times; `fn_ca_payout_rows_without_money(3)` (also `LANGUAGE sql`) scanned all
  876k payouts and the whole idempotency table for three days of payouts
  (13-55 s); `fn_unaccounted_seat_exits` scanned all 6M `wallet_transactions`
  for 1,052 correction rows.
- **123.** The co-seating signal read every seat joined in 24 hours (87,000,
  all but a few dozen of them horses' seats; `table_seats` has no `joined_at`
  index) and joined each to its table: 41 s cold. It also shared :35 with two
  other heavy watches.

## What Changed

The same checks, reading less. No check was removed, no job added, no repair
written (CLAUDE.md 10.12). Horses are counted exactly as before (10.5).

1. `fn_bbj_reconcile` always plans generically (`SET plan_cache_mode`).
   The body is byte-identical.
2. `fn_rake_attribution_drift` and `fn_ca_payout_rows_without_money` are the
   same queries in plpgsql, planned with the window's value.
3. `fn_bbj_promo_bank_check` reads the contributions once.
4. `fn_club_table_daily_catchup` rebuilds a complete day on the first run that
   sees it, whenever its facts, raked hands or attributions move (fingerprinted
   in the new `club_table_daily_refresh_marks`), and once more on the first run
   twelve hours after the day closed. Today is still the triggers' and still
   skipped. The ledger-against-rollup check of every complete day is unchanged.
5. `fn_union_integrity_sweep` finds co-seated pairs from the seats of players
   who are not horses (every counted pair has one) through `idx_table_seats_user`.
   Same pairs, same counts, same order and limit.
6. Three indexes, built concurrently before the transaction:
   `idx_tournament_payouts_paid_money`, `idx_wallet_credit_idempotency_created`,
   `idx_wallet_tx_seat_exit_corrections`.
7. `union-integrity-sweep` moves from :35 to :33. Nothing else is rescheduled.

Not changed, by scope: `union-weekly-rakeback-close` (job 272). Its long runs
are the weekly close itself working through Deep Stack Society's standalone
book, which is owned by #7660/#7674.

## Proof

`scripts/ci/test-the-hourly-audits-stop-holding-the-hot-tables.py` loads the
exact production definitions captured 2026-10-22 (md5 equal to production),
records every function's answer on fixtures covering each branch, installs the
migration, and requires identical answers, unchanged owners and grants, the
catchup's rebuild rules, and a refused second install. It runs in `ci.yml`
shard 4. `tests/the-hourly-audits-read-less-and-answer-the-same.law.test.ts`
pins the shapes.
