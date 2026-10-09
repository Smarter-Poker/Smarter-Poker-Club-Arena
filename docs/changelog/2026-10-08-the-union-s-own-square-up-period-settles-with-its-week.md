# The Union's Own Square-Up Period Settles With Its Week (2026-10-08)

Migration `20261008050208_the_union_s_own_square_up_period_settles_with_its_week.sql` (HELD).

## What Was Wrong

Midway Union's week of 2026-09-28 closed on 2026-10-07 at 21:42 UTC
(`union_accounting_runs` status `complete`), yet its own club row's settlement
period (`cc6c056b`, clubs.id = union id) stayed `processing`. That one row is the
only offender behind `fn_union_governance_check`'s
`settlement_period_overdue_open`, which `fn_ca_conservation_sweep` pages hourly.

## Root Cause

Inside `fn_union_settlement_cascade` the settler
(`fn_mark_scope_accounting_settled`) runs before round 4, and round 4
(`fn_union_issue_weekly_invoices`) opens a `processing` period for every club it
bills that has none, the union's own club row included. `20261003024413` taught
the settler to include the union's own row, but only a row that already exists
when it runs. This week the closing attempt opened it, after the settler had
finished, and a week recorded `complete` is never visited again.

## Not The Cause

The `weekly_scope_time_budget_exhausted` failure at 21:20 UTC carried a budget of
`1 minute`. Job 272 sets only 9 or 50 minutes, and its 21:15 and 21:20 ticks each
finished in under 30 ms, so that attempt was an out-of-band call. The scheduler's
own next attempt closed the week in 7 minutes 20 seconds. No budget changes.

## The Fix

- The cascade runs the idempotent settler once more after the square-up is proved
  delivered, and refuses to succeed while any period of the week is neither
  `settled` nor `closed` (`union_week_period_left_unsettled`).
- The stranded week is closed by its own path, guarded on the exact row read on
  2026-10-08 and on the week's run being `complete`. No chips move.

## Proof

`scripts/ci/test-union-own-period-settles.py` runs the exact live cascade and
settler (md5 pinned) on native PostgreSQL: the live text strands the own-club
period, the candidate settles every period, closes `cc6c056b` without moving any
other row, reproduces production's derived postimage md5 and refuses a second
run. Workflow: `.github/workflows/union-own-period-settles.yml`.
