# An audit runs under the budget it was measured against (2026-10-03)

Launch-gate sweep. Migration `20261003025058`.

## What the rows said

`cron.job_run_details`, production, 6 hours to 02:20 UTC. Eight jobs were cancelled at exactly 120 s although their successful runs need up to ~117 s, and two audits were cancelled at their 300 s budget:

| job | name | failed / 6 | measured |
|---|---|---|---|
| 128 | club-rake-rollup-catchup | 3 | ok runs 58-81 s; function declares 600 s that never applied |
| 134 | bbj-rollup-catchup | 2 | building 2026-10-02 (86,000 contributions) takes ~90-110 s; never landed |
| 143 | spin_unpaid_check | 3 | ok runs up to 117 s |
| 178 | ca-settlement-correctness-30m | 3 | ok runs up to 107 s |
| 231 | ca-pay-backed-payout-shortfalls-hourly | 3 | ok runs up to 117 s; `SET LOCAL '120s'` first statement |
| 123 | union-integrity-sweep | 1 | 122 s; inner `set_config('120s')` is the ineffective kind |
| 157 | reconcile-ledger-integrity-6h | 1 | function declares 300 s that never applied |
| 76 | refresh-player-stats-hourly | 4 timeouts + 1 deadlock | the one success took 40 s |
| 227 | ca-payout-guarantee-check-hourly | 4 | 7-day window = 120,208 events, four per-event loops |
| 144 | tourney_money_conservation_hourly | 2 | 17,188 events in 2 days at ~8 ms each |

## What changed

- The eight jobs open with `SET statement_timeout = '300s';` (231's `SET LOCAL '120s'` is replaced).
- 227 calls `fn_payout_guarantee_check(2)`: the earners loop measured 9,965 ms over one day; every completed event is still checked 48 times, and the clearing pass over open alerts is not windowed.
- 144 calls `fn_tournament_money_conservation(1, 1.0, 200)`: every event is still checked ~23 times after its 30-minute grace, and pass 1 still re-checks every open alert whatever its age.

No function body, schedule, grant or index changes. Function rewrites that make spin_unpaid_check, the settlement correctness check, the ratchet watch and the stats witness audit cheaper ship in a separate migration of the same sweep.
