# A Failing Hourly Cron Reaches The Board (2026-10-07)

Migration `20261007215818_a_failing_hourly_cron_reaches_the_board.sql`. Supersedes PR #5730 (`20261001152917`, `20261001152926`).

## Root Cause

`fn_ca_cron_failure_watch` raised an incident only for a job with at least 5 failures and no success inside the last 2 hours. An hourly job can fail at most twice in 2 hours, so no hourly or slower job could ever be reported. On 2026-09-27 `ca-conservation-sweep-hourly` failed 23 of 24 runs and nothing reached `ca_drift_incidents` or `operational_alert_events`.

## Fix

The rule no longer depends on cadence. An active job is failing when its last three finished runs all failed and it has not succeeded in 2 hours, or when in 24 hours it failed at least 5 times and more often than it succeeded. `cron.job_run_details` is read once, bounded to 7 days. Applied as a pinned-text substitution over today's live text (md5 `32c0a028ed80fd1d277515790d0b446e` to `f8657d84657bf72112cd07ae40798d73`, derived read-only on production), so the ledger-refusal block main appended on 2026-10-02 is kept byte for byte. The guard redefinition is declared in the same transaction.

Read-only on production 2026-10-07, no active job meets either rule, so the install raises nothing today.

## What Was Dropped From #5730

The four covering indexes for the hourly conservation sweep: main fixed the sweep, which has completed every run since 2026-10-04 in 40 to 58 seconds.

## Regression

`scripts/ci/test-cron-failure-watch-reaches-the-board.py`, run by `.github/workflows/cron-failure-watch-reaches-the-board.yml` on PostgreSQL 17.
