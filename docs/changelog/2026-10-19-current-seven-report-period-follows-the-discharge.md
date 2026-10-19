# The current-seven report period follows the discharge, not the calendar

Date: 2026-10-19

## What broke

The required CI step "Original inventory restoration admits only qualified
finite financial evidence" (Accounting transactions, PostgreSQL 17, shard 3/4)
began failing on every pull request at 2026-10-19 07:00 UTC with:

    actual-b9-current-seven-report-cash-conservation: ERROR:  P0001: exactsevenactualheldsource_refused

## Cause

The qualification runs the seven original discharges inside an isolated
PostgreSQL 17 cluster. Each discharge records `discharged_at` as the real
`transaction_timestamp()` of the test run. The report script
`scripts/qualification/original-retirement-boundary/actual-b9-current-seven-report-native.sql`
then read the "current" week with a literal close of `2026-10-19 07:00:00Z`
(and the replay case in
`scripts/qualification/original-seven-discharge/test-discharge.py` did the
same). `original_erased_cash_discharge_returns` correctly excludes a discharge
at or after the period end, and `original_erased_cash_receivables` correctly
still holds an amount discharged after the asked instant. So once the wall
clock passed 2026-10-19 07:00 UTC, the test's own discharges fell after its
hard-coded period: zero returns instead of seven, and the receivable still held
at the close. The guard did exactly what it should; the fixture had a calendar
date baked in. Main's last green run (04:45 UTC) was before the boundary.

No production function or migration was involved.

## Fix

The report now derives its close from the discharges the transaction actually
recorded: the first weekly boundary (anchored at the certified
2026-10-12 07:00Z opening, seven-day steps) after the latest `discharged_at`.
It also refuses if there are not exactly seven discharges or any falls outside
the period. Before 2026-10-19 07:00 UTC this is exactly the old literal
(2026-10-19 07:00Z); after it, the period rolls forward week by week. The
opening receivable stays at the certified 2026-10-12 07:00Z boundary and every
assertion (seven returns, 1845.87 opening, 0 closing, 0 net/rake/winnings,
replay unchanged, historical boundary held total 1845.87) is unchanged. The two
changed files are re-pinned in `source-binding.json`.

## Proof

- Before (origin/main, run locally at 11:0x UTC): fails with
  `exactsevenactualheldsource_refused`, same as CI.
- After: `original-seven-discharge/run-native.py` passes all 30 cases
  (discharged_at 2026-10-19T11:12Z, period close 2026-10-26 07:00Z), and the
  full step `original-retirement-boundary/run-native.py` prints
  "Finite inventory245/raw/cache/retention/currentseven qualification PASS".
- `tests/an-original-inventory-gap-needs-its-financial-evidence.law.test.ts`
  (byte pins) passes.
