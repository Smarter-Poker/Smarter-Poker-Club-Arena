# A cash pot audit reads the hours since its last run (2026-10-03)

Launch-gate sweep. Migration `20261003044110`.

## What the rows said

`ca-cash-pot-conservation-hourly` (job 259, `34 */6 * * *`) read 24 hours of cash hands every 6 hours, so each hand four times. Cash volume is now ~16,600 cash hands with a pot per hour, and the scan is IO-bound (one uncached hour: 8,106 pages from disk, 12.5 s).

| run (UTC)        | outcome                        |
| ---------------- | ------------------------------ |
| 2026-10-02 00:34 | cancelled at 600 s in the scan |
| 2026-10-02 06:34 | cancelled at 600 s             |
| 2026-10-02 12:34 | ok, 569 s                      |
| 2026-10-02 18:34 | ok, 350 s                      |
| 2026-10-03 00:34 | cancelled at 600 s             |

## Where a failure goes

Trigger `ca_cash_failed_run_intake` on `cron.job_run_details` delivers each failed run to `operational_alert_events` (source `cash-pot-conservation-cron-failure`, severity critical, addressed to the production-alerts fleet task) and records it in `ca_cash_failed_run_outcomes`. Nothing reads that inbox into `ca_drift_incidents`: the table has no trigger or publication and no database function relays it. The only cron-failure path into `ca_drift_incidents` is `fn_ca_cron_failure_watch` (5 failures and no success in 2 hours), which a 6-hourly job cannot reach. So a failure never moved the burn-in gate, but while the job failed, no cash pot was checked.

## What changed

- Job 259 calls `fn_cash_pot_conservation_check(8)`. Measured over 8 hours in 2-hour bands: 124,889 rows in 62.7 s, against a 600 s budget.
- `fn_ca_cash_failed_run_intake`'s pinned `v_command` is edited in the same transaction (exact substitution, md5 pre- and postimage, owner, security and grants unmoved), so a failure is still delivered rather than refused as "job contract drift".
- The CI scheduler fixture (`scripts/ci/test-cash-failure-pgcron.py`, `supabase/components/cash-failed-run-intake*.sql`) carries the new command and `scripts/qualification/cash-native-hosted.manifest.json` is restamped. The migration header also names the reader and qualification SQL; those are source-only, unrun packets (`scripts/operational-alerts/cash-pot-failed-run-intake.sql` and its qualification) whose acknowledgement check matches every retained receipt's recorded command, so they keep the command the existing receipts carry and are left unchanged. The live trigger is the intake.

The schedule, the checker body, its 48-hour ceiling, its alerts and its evidence are unchanged.
