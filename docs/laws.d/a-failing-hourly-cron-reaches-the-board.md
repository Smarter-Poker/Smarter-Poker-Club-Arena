# tests/a-failing-hourly-cron-reaches-the-board.law.test.ts

`fn_ca_cron_failure_watch` reports a failing job whatever its cadence: three straight failed runs with no success in two hours, or at least five failures and more failures than successes in 24 hours. The old ">= 5 failures and 0 successes in 2 hours" rule could never fire for an hourly job, which is how the conservation sweep failed 23 of 24 runs on 2026-09-27 without reaching the board.

It reads `cron.job_run_details` once, bounded to the last 7 days. That table is indexed only by `runid` and keeps every run, so a per-job "last three runs" lookup without a time bound scans the whole table once per active job, every 30 minutes. One window pass ranks each job's finished runs newest first and gives both the 24 hour counts and the last-three rule.
