# 2026-09-24: A settled satellite's own batch already proves the seat

Production Alerts board: `operational_alert_events` id=8, `MoneyAlertsGoingUnread`,
alertname `Satellite.seat_outcome_unconfirmed`.

## What was wrong

Five `financial_alerts` rows of this source (`a619dd26`, `4e84ec39`, `eb304c2e`,
`d741d403`, `bade4d66`) have sat unresolved since 2026-09-08, each carrying a
transient failure message from the pre-fix code path (`FOUR TABLE LIMIT`,
`permission denied for function fn_award_satellite_seat`, and their sibling
`deadlock detected`). A sixth row of the same source (`3ed87bba`) was already
resolved by hand, with a note naming the 2026-09-09 22-satellite settlement
and explicitly correcting that alert's own context as stale. These five were
the untouched remainder of that exact settlement.

## What was actually true, read live

All five named source tournaments already carry a settled
`tournament_satellite_settlement_batches` row from 2026-09-09 06:14 UTC:

| source tournament | winner | ticket | delivery | proof |
|---|---|---|---|---|
| `fe8dc50c` | `...045` (horse) | 20 | seat | `tournament_players` id `bb1abd4e`, target `d2910755`, status `eliminated`, position 39 |
| `ed78a8ac` | `20a40df1` | 20 | cash | `tournament_obligations` `237d5c30`, paid; `chip_ledger` credit 20.00 at 06:14:22 |
| `024d0796` | `cba6d788` | 20 | cash | `tournament_obligations` `ccfaaf05`, paid; `chip_ledger` credit 20.00 at 06:14:22 |
| `903e9d3c` | `c0129701` | 20 | cash | `tournament_obligations` `eaec49e9`, paid; `chip_ledger` credit 20.00 at 06:14:22 |
| `54832de2` | `...008` (horse) | 200 | cash | `tournament_obligations` `88382433`, paid; `chip_ledger` credit 200.00 at 06:14:28 |

No money was ever missing. The alert rows were simply never marked resolved
after the settlement that fixed them landed.

## The fix

`supabase/migrations/20260924012500_a_settled_satellites_own_batch_already_proves_the_seat.sql`
adds CLASS 5 to `fn_resolve_settled_financial_alerts`: a
`Satellite.seat_outcome_unconfirmed` alert resolves once its named source
tournament's own settlement batch has `settled_at` set.
`fn_settle_satellite_finish_atomic_before_maintenance_gate` only ever sets
that column after every entitlement in the tournament was delivered and the
`fn_check_atomic_satellite_finish` postcondition passed with no exception, so
`settled_at IS NOT NULL` is itself the complete proof — no per-row check is
needed, and none is skipped by relying on it.

No money moves. The resolver runs on its existing 20-minute cron
(`ca-resolve-settled-alerts-20m`); no new function, cron, or table.

## Verification

Probed in a rolled-back transaction (CLAUDE.md 11.5) immediately before
writing the migration: the full `CREATE OR REPLACE` plus a live
`p_apply => true` call inside one self-aborting `DO` block, asserting
`satellite_seat_outcome_settled = 5` and that exactly the five expected alert
ids read `resolved = true` inside the probe transaction, ending in a
deliberate `RAISE EXCEPTION` so nothing committed.
