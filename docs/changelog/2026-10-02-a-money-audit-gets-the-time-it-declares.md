# A money audit gets the time it declares (2026-10-02)

Launch-gate sweep. Migration `20261002170500`.

## What the rows said

In the 12 hours to 16:00 UTC, the hourly money audits were cancelled by statement timeout more often than they finished: ca-ratchet-watch 9 of 12, ca-escalate-reconcile-criticals 8 of 12, rake-attribution-drift 7 of 12, ca-payout-guarantee-check 7 of 12, rake-bbj-invariant 5 of 12, tourney money conservation 3 of 12, stats witness 5 of 48; ca-results-without-a-hand had no success in 12 hours and the daily union-law self-test failed on 10-01 and 10-02. A cancelled audit leaves its invariant unchecked for that run, and the cron-failure watch files an "unknown" incident that holds the burn-in launch gate red.

- **The budget never applied.** pg_cron statements run under the role's 2-minute limit. A `set_config('statement_timeout', ...)` inside the cron statement, or a `SET` on the function, does not change the timer of the statement already running. Only a separate first statement in the command does (as ca-conservation-sweep-hourly already does).
- **Two windows re-read far more than one run needs.** rake-attribution-drift re-checked 24 hours every hour (~140 s; one hour measured 6.0 s). ca-results-without-a-hand re-read 7 days every 6 hours (109,817 events).
- **The treasury aggregate had no index.** `fn_ca_treasury_positions` scans every `club_treasury` leg since the baseline: two full scans of `chip_ledger` (8.1M rows) per call, once per critical treasury.

## What changed

- Nine audit commands open with `SET statement_timeout = '300s';` (600 s for the daily union self-test).
- rake-attribution-drift reads 2 hours per hourly run (every hour checked twice); results-without-a-hand reads 1 day per 6-hourly run (every event checked four times).
- Partial index `idx_chip_ledger_treasury_in` on the treasury credit legs, built concurrently before the transaction. The matching debit index could not be built concurrently under write load; its invalid build `idx_chip_ledger_treasury_out` is unused by any plan and is left for a quiet window to drop and rebuild.

No function body changes; no audit is weakened.
