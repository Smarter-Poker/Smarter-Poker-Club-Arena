# The Settler Lag Reads What The Settler Reads (2026-10-15)

## What Fired

`fn_ca_conservation_sweep:fn_settler_lag_check` (76 open rows),
`fn_ca_settlement_correctness_check:settler_lag` (40) and
`fn_union_treasury_selftest` "rakeback_settler_lagging" all read one probe,
`fn_settler_lag_check()`. None of them was a settler that had stopped.

## Cause, Read From Rows

- No rake row was written from 2026-10-13 19:17 to 2026-10-14 23:04 UTC. The
  settler returns `idle` and saves nothing, so the cursor aged to 27.57 hours
  and the probe called an idle settler unhealthy with `backlog_rows` 0.
- Eleven minutes after play resumed, 1,545 fresh rows sat above a 27-hour-old
  save, and `stalled = stale > 45 min AND backlog > 0` fired on rows the next
  30-minute cycle drained.
- The settler pages `rake_amount > 0` only. 853 rake reversals written
  2026-10-13 16:10 to 16:17 could never move its cursor, yet were counted as
  backlog, and the treasury self-test filed "rakeback_settler_lagging".

## Fix

`fn_settler_lag_check()` now counts the rows the settler reads (positive,
above its `(created_at, id)` keyset) and measures the lag as the age of the
oldest of them. A stall is such a row waiting longer than the grace. The
cursor age stays visible as `cursor_age_hours`. Migration
`20261015024150_the_settler_lag_reads_what_the_settler_reads.sql` (pinned
preimage `5cdd53e0`, derived postimage `84bf7dc6`).

## Regression

`scripts/ci/test-settler-lag-reads-what-the-settler-reads.py`, run by
`.github/workflows/settler-lag-reads-what-the-settler-reads.yml`: the live
definition misreads the three real cases, the candidate reads them healthy,
and a skipped cycle, a seven-hour lag, a keyset tie and a blocked week stay
unhealthy.

## Also: A Finding With No Amount Is Not A Chip Drift

Nine open `financial_incident:0.00 chip drift: ledger_imbalance` rows were
liveness findings (`fn_ca_knockout_door_stalled`, one finding each), not
drifts. `fn_ca_raise_drift_incident` built every chip headline as
`<amount> chip drift: <classification>`, so a check with no amount paged as a
drift of 0.00 and hid which check fired. A finding with no amount is now
headlined `<source> is <severity>`, as a Diamond rule already is. A real
drift keeps its amount. Migration
`20261015024752_a_finding_with_no_amount_is_not_a_chip_drift.sql` (preimage
`e6dac566`, postimage `b5025fd1`), regression
`scripts/ci/test-a-finding-with-no-amount-is-not-a-chip-drift.py` in the same
workflow.
