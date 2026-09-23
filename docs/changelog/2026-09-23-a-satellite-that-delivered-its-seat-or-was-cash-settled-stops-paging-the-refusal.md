# A satellite that delivered its seat or was cash settled stops paging the finish refusal

2026-09-23. Production Alerts board: `operational_alert_events` id=8,
`MoneyAlertsGoingUnread`.

## Context

The prior migration in this chain (`20260923184855`, PR #5145) added CLASS 5
to `fn_resolve_settled_financial_alerts` for the two non-satellite
finish-refusal sources (`Tournament.atomic_finish_refused` and
`Tournament.atomic_finish_outcome_unknown`), proven against a
`wallet_transactions` prize credit. It deliberately left the satellite
sources untouched: a satellite's payout is a seat or ticket awarded, not
necessarily a single wallet credit, so CLASS 1's proof shape does not
automatically transfer.

## What was read live

- `Tournament.atomic_satellite_finish_refused`: 469 unresolved rows, 39
  distinct `(tournament_id, winner_id)` pairs.
- `Tournament.atomic_satellite_finish_outcome_unknown`: 8 unresolved rows.
- Checked two proofs, per row, against the alert's own `tournament_id` and
  `winner_id`:
  1. `tournament_satellite_awards` carries a row for that exact pair - a seat
     or ticket into the target event was delivered. Covers 467 of 469
     `satellite_finish_refused` rows and 8 of 8 `outcome_unknown` rows.
  2. A different `financial_alerts` row for the identical
     `(source, tournament_id, winner_id)` triple is already `resolved=true`.
     Needed for exactly 2 of 469: satellite `9fee70de-c692-48fb-a423-
     98d730ab02bc`'s place-1 ticket had "no exact target club", so it was
     terminal-settled as **cash** instead of a seat award (resolution on row
     `ba1c42e7`, 2026-09-10, via `fn_settle_satellite_finish_atomic`,
     migration `20260910023919`) - which correctly never writes to
     `tournament_satellite_awards`, leaving that pair's two earlier duplicate
     alert rows open even though the winner was paid.
- Every one of the 477 unresolved rows across both sources is covered by proof
  (1) or (2); none were found with neither.

`Satellite.seat_origin_unknown`, `Satellite.seat_outcome_unconfirmed` and
`Satellite.stuck_completing_unawarded` (533 rows) are a different failure
shape - a satellite that never finished at all - and are deliberately left
open here.

## Fix

`supabase/migrations/20260923195015_a_satellite_that_delivered_its_seat_or_was_cash_settled_stop.sql`
adds CLASS 6 to the existing `fn_resolve_settled_financial_alerts`, restating
CLASS 1-5 verbatim so the migration is correct standalone regardless of merge
order relative to PR #5145.

## Hardening (CLAUDE.md 10.11/10.12)

- Root cause fixed at the source: the missing class in the existing resolver,
  not a new sweep, cron, or compensating write.
- Damage settled through the resolver's own existing idempotent path, on its
  existing 20-minute cron (`ca-resolve-settled-alerts-20m`).
- Regression test:
  `server/src/tournament/ASatelliteThatDeliveredStopsPagingTheRefusal.guard.test.ts`
  pins the exact SQL added.
- Detection: none needed - `MoneyAlertsGoingUnread` already measures the
  backlog this closes a further 477 rows of.

## Not touched

`Satellite.seat_origin_unknown`, `Satellite.seat_outcome_unconfirmed`,
`Satellite.stuck_completing_unawarded` (533 rows), and the weekly club/union
accounting sources (358 rows) remain open on the board.

Production Alerts Fleet - PRIMARY lane. Board:
Smarter-Poker/Smarter-Poker-Club-Arena#5070.
