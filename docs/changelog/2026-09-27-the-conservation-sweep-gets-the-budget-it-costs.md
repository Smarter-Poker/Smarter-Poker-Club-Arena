# The conservation sweep gets the budget it costs

2026-09-27. Migration `20260927164653_the_conservation_sweep_gets_the_budget_it_costs`,
law `tests/the-conservation-sweep-gets-the-budget-it-costs.law.test.ts`.

## What was wrong

`ca-conservation-sweep-hourly` runs `fn_ca_conservation_sweep()` (30 checks, one
top-level statement) under the postgres login's 2-minute statement_timeout. In
the 24 hours to 16:00 UTC it completed once (11:52, 106.98 s). Every other run
was cancelled at exactly 120 s, each inside whichever check was running when
the total crossed the line.

A statement timeout is QUERY_CANCELED, which `EXCEPTION WHEN OTHERS` does not
catch. So each cancelled run rolled back its findings and its
`ca_detector_runs` row.

- The widest conservation check on the platform was blind 23 hours in 24.
- `fn_ca_resolve_cleared_incidents` needs two recorded sweep runs to close a
  sweep incident, so none could ever close.
- The five open sweep incidents were last re-measured at 11:52.

## Measured

On 2026-09-27 at about 16:50 UTC, each check was timed in one call that was
rolled back:

- `fn_chip_integrity_report`: 78.3 s. On a warm re-run,
  `fn_chip_drift_since_baseline` alone took 24.7 s.
- `fn_ca_payout_rows_without_money`: 30.6 s.
- Every other check: under 3 s.

## Fix

The job's command now sets `statement_timeout = '600s'`, as
`ca-cash-pot-conservation-hourly` and `tourney_money_conservation_deep_daily`
already do. That is five times the measured cost and a tenth of the period.
The schedule, function, role and database are unchanged. The migration refuses
to overwrite a command it did not measure (md5 check) and reads its own write
back. There is no DDL and no PostgREST reload.

## Still open

`fn_chip_integrity_report` costing over a minute is its own defect, and this
budget does not hide it: the number is recorded here.
