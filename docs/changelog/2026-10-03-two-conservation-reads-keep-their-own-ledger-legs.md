# Two conservation reads keep their own ledger legs (2026-10-03)

Launch-gate sweep. Migration `20261003051230`.

## What the rows said

`ca-conservation-sweep-hourly` (job 233, `:52`, 600 s budget) runs `fn_ca_conservation_sweep()`, 30 checks in one statement. It took 114-376 s per run, and the 22:52 run on 2026-10-02 was cancelled at 600 s inside `fn_bbj_conservation_check`. Two serial reads of `chip_ledger` (8.49M rows, 3.9 GB heap) were most of every run. Both walked `idx_chip_ledger_created_at` and fetched every heap row in their window:

| read                                       | window                 | rows kept                      | before |
| ------------------------------------------ | ---------------------- | ------------------------------ | ------ |
| `fn_bbj_conservation_check` epoch identity | since 2026-09-04 21:17 | 3,553,232 bbj legs out of 7.1M | ~61 s  |
| `fn_chip_drift_since_baseline`             | since 2026-08-27 01:08 | 1.49M player legs out of ~8.4M | 55.8 s |

## What changed

Two partial indexes. Each predicate is exactly the read's own leg filter, and each index carries every column the read uses:

- `idx_chip_ledger_bbj_pool_legs` (230 MB). The epoch read is an index-only scan: 3.02 s serial with a cold cache. The whole check takes 4.5 s and reports `healthy` true and `drift_from_baseline` -9.82.
- `idx_chip_ledger_player_wallet_legs` (172 MB). `fn_chip_drift_since_baseline` takes 1.8 s and returns the same 670 drifting memberships, worst 103,747.97.

Each `CREATE INDEX CONCURRENTLY` ran as the whole command of a one-shot pg_cron job (403 and 404, 64 s each, both unscheduled afterwards). The role's 15-minute `statement_timeout` was in force only for the seconds around each start and was then RESET, which was checked afterwards. No function body, schedule, grant or constraint changes.
