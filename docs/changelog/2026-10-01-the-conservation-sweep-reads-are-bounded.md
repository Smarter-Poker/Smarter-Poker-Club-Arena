# The conservation sweep reads are bounded, and a failing hourly cron reaches the board

Incident `ca-conservation-sweep-hourly`. Migrations `20261001152917` (recording only, after the online build in `scripts/ops/build-conservation-sweep-read-indexes-concurrently.sql`) and `20261001152926` (detector). HELD: migrations.

## What was wrong

`fn_ca_conservation_sweep` runs 30 checks inside one cron statement. Until 2026-09-28 it ran under the `postgres` role's 120 second `statement_timeout`. A cancel (SQLSTATE 57014) is not caught by the per-check `EXCEPTION WHEN OTHERS`, so one slow read rolls back the whole sweep and records nothing for any conservation class. On 2026-09-26 8 of 24 runs completed, on 09-27 4 of 24 and on 09-28 11 of 24. Each cancel lands wherever the clock runs out, so no single error names the cause.

`3b6033cd7` (#5462) gave the job a 600 second budget, and since 2026-09-28 14:52 UTC every run has completed. That hid the outage but not its cause: the sweep's cost keeps growing with history. Daily average duration from `cron.job_run_details`: 56 s on 09-25, 98 s on 09-27, 178 s on 09-28, 194 s on 09-29, 230 s on 09-30 and 260 s on 10-01 (maximum 321 s). At that rate the 600 s budget is crossed within about two weeks, and the sweep already burns four to five minutes of database CPU every hour.

Re-measured read-only on 2026-10-01 around 15:00 UTC, each sub-check alone: `fn_ca_payout_rows_without_money(3)` took 74.1 s (312,465 buffers) to return 0 rows; `fn_chip_integrity_report()` was cancelled at the 120 s statement limit inside `fn_chip_drift_since_baseline`; `fn_bbj_conservation_check()` was cancelled at 120 s inside its epoch sum over `chip_ledger`. `chip_ledger` holds about 7.6M rows (3.5 GB heap).

The first measurement, each sub-check alone, read-only, on production on 2026-09-27 between 16:05 and 16:30 UTC. The settlement and satellite reads had already been indexed by #5392. Three reads grow with all of history:

- `fn_chip_drift_since_baseline`, inside `fn_chip_integrity_report`, the first check. Hot and serial it takes 4.7 s: an index scan on `created_at` touches 3,275,432 buffers to sum 1,032,144 `player_wallet` legs out of 6.2M ledger rows since the 2026-08-26 baseline. Through the function it took 6.9 to 31.8 s depending on cache and load, and the 00:52 UTC cancel landed inside it.
- The epoch identity in `fn_bbj_conservation_check`. Hot and serial it takes 3.5 s: 2,395,022 buffers for 2,524,067 `bbj_pool` legs out of 4.86M rows.
- `fn_ca_payout_rows_without_money`. It takes 4.3 to 5.8 s: a sequential scan of all `tournament_payouts` (106 MB) for a 3-day window, plus `min(created_at)` of `wallet_credit_idempotency` read by a sequential scan of 125 MB.

The sweep runs at :52, beside the hand-history prune, compact and vacuum jobs, so these reads usually start with a cold cache.

Nothing reported the outage. `fn_ca_cron_failure_watch` raised an incident only for a job with at least 5 failures and 0 successes in the last 2 hours. An hourly job can fail at most twice in two hours, so that rule could never fire for it. At 16:40 UTC the same blind spot was also hiding `rake-bbj-invariant-audit-hourly` (15 of 24 runs failed), `ca-settlement-correctness-30m` (13 of 24) and `ca-guard-defs-hourly` (its last 3 runs failed).

## The fix

- Four online indexes. Two on `chip_ledger` are partial and covering, so the drift and BBJ epoch reads become index-only scans of exactly the legs they sum. `tournament_payouts(paid_at)` narrows the 3-day window, and `wallet_credit_idempotency(created_at)` makes the minimum a single probe. No function, predicate, grant or result changes. The recording migration refuses unless all four exist with the exact shape and are valid, and the three reading functions are byte-identical to the qualified bodies.
- `fn_ca_cron_failure_watch` now uses a rule that does not depend on a job's cadence. A job is reported when its last three finished runs all failed with no success in 2 hours, or when, over 24 hours, it has at least 5 failures and more failures than successes. It reads `cron.job_run_details` once, bounded to the last 7 days: that table keeps every run since 2026-08-06 (about 358k rows) and is indexed only by `runid`, so a per-job lookup of the last three runs without a time bound would scan it once per active job every 30 minutes. One window pass gives both the 24 hour counts and the last three finished runs. The incident source, per-day key, severity and routing are unchanged.

## Hardening

1. Regression tests:
   - `scripts/ci/test-conservation-sweep-read-indexes-postgres.py` runs the production bodies, md5-pinned. Results are identical before and after. Every read switches to its index, and chip_ledger buffers fell from 31,258 to 2,574 on the PostgreSQL 16 fixture. The recording migration refuses when the indexes are missing, have the wrong shape, are invalid, or when the source has changed.
   - `scripts/ci/test-cron-failure-watch-postgres.py` shows that the production body sees only the per-minute outage. The new body reports the hourly sweep, a flapping 30-minute job, an inventoried guard and a daily job whose last three runs failed, and ignores a healthy job, a brief blip and an inactive job. Its plan reads `cron.job_run_details` exactly once, through the 7 day bound, with 100 extra active jobs.
   - Law: `tests/a-failing-hourly-cron-reaches-the-board.law.test.ts`, 4 of 6 failing without the migration and 6 of 6 passing with it.
2. Invariants: the recording migration's shape and source checks; `fn_ca_cron_failure_watch`'s pre-image guard and its post-image guard (body md5, owner, ACL, search_path, SECURITY DEFINER and volatility).
3. Detection: the watch raises through `fn_ca_raise_drift_incident`. The intake carries those incidents into `operational_alert_events` with the fleet `target_task_id`; the existing `fn_ca_cron_failure_watch` receipts already show that route.
4. CI: both native proofs run in the dedicated workflow `.github/workflows/conservation-sweep-read-proofs.yml` (throwaway PostgreSQL 17, unprivileged runner user) on every pull request that touches either migration, the online build script, either proof or its fixtures. `tests/conservationSweepReadIndexesRegression.test.ts` pins that trigger and both steps. A dedicated workflow keeps `ci.yml` and `scripts/ci/classify-ci-changes.mjs` (and the source bindings that pin them) unchanged.

Production install and the sweep duration after install are separate evidence, recorded against the incident. The 600 s job budget of #5462 is left as it is: this change removes the cost it was covering, it does not depend on it.
