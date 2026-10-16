# The Money Check Board Reads The Cron Runs That Drive Each Check

## What Was Wrong

`fn_money_check_health` raised seven critical financial alerts at 2026-10-15
10:07 UTC ("<check> has never run"), as it did on 2026-09-02. It read only
`money_check_heartbeat`, whose single writer `fn_record_money_check_run` has no
caller anywhere, so every row read `run_count 0` and `last_run_at NULL`. The
checks themselves run on pg_cron and every run in the last 24 hours succeeded.
The seventh row, `fn_backpay_unfinalised_bounty_pools`, is a repair job whose
schedule was retired on 2026-09-22 (`docs/BAND-AIDS-REGISTER.md` item 3), and
the cash pot check runs every six hours against a registered hour.

## The Fix

Migration `20261015101106_the_money_check_board_reads_the_cron_runs_that_drive_each_ch`
(pinned preimage `5fccb514...`, postimage `7bcc8d06...`): a check's last run is
the later of its heartbeat and the last succeeded run of an active cron job
whose command calls it, over the last eight days. A failing, deactivated or
unscheduled job still reads stale. The registry expects the cash pot check
every 360 minutes and drops the retired repair job.

## Pinned By

`scripts/ci/test-money-check-health-reads-cron.py` on native PostgreSQL with
the production function (workflow `money-check-health-reads-cron.yml`): seven
false criticals before; after, only a failing job raises and a deactivated job
is stale.
