# SpinDrawBookingGapOpened

Runbook for `SpinDrawBookingGapOpened` in `infra/monitoring/spin-rules.yml`
(group `spin-money`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-booking-gap`, which has never
served anything.

## What it means

```
poker_spin_draw_booking_gaps > 0   for: 5m   severity: critical
```

A Spin that ended in the last 24 hours paid its winner the full advertised
prize, `round(buy_in_amount * spin_multiplier, 2)`, while the reserve pool's
`jackpot_draw` row recorded a smaller amount. The players were paid correctly;
the pool's books under-state what left it, so every reserve balance, thin-pool
decision and reconciliation that reads `spin_reserve_ledger` is wrong by the
difference. This class was closed on 2026-08-24; a new row means it reopened.

## What the expression measures

The `bg` CTE of `fn_spin_metrics`: Spins with `spin_multiplier` set and
`ended_at` in the last 24 hours where the sum of `-amount` over
`spin_reserve_ledger` rows of kind `jackpot_draw` is not null, the prize
credited to wallets is not null, and credited is greater than drawn and equal
to the advertised prize. It deliberately cannot see a Spin with no ledger row
at all; that is `SpinDrawNeverBooked` (`docs/runbooks/spin-never-booked.md`).
The eleven historical rows from 2026-08-22 to 08-24 are outside its 24-hour
window by construction.

## First checks

1. The rows with the amounts, read-only:
   ```sql
   SELECT tournament_id, club_id, name, buy_in_amount, spin_multiplier,
          started_at, ended_at, drawn_at, prize_drawn, prize_credited, draw_under_booked_by
   FROM v_spin_draw_booking_gaps
   WHERE ended_at > now() - interval '24 hours'
   ORDER BY ended_at DESC;
   ```
2. For one tournament, every reserve row and the multiplier the draw recorded:
   ```sql
   SELECT kind, amount, multiplier, buy_in, seats, note, created_at
   FROM spin_reserve_ledger WHERE tournament_id = '<id>' ORDER BY created_at;
   ```
   A `jackpot_draw` whose `multiplier` differs from `tournaments.spin_multiplier`
   means the tier was changed after the draw was booked.
3. The engine log for that launch:
   `docker logs --since 24h club-arena-engine 2>&1 | grep <id> | tail -40`.

## Likely causes

- A second writer set `tournaments.spin_multiplier` after
  `fn_spin_draw_and_settle_atomic` booked the draw (the historical shape: the
  booking and the payout read different multiplier steps).
- A code path that settles a Spin outside the atomic receipt.

## Settling the damage

The pool's record is corrected with a new `adjustment` row written through the
reserve's own journaled path (`fn_spin_reserve_row_requires_exact_journal`
refuses a reserve row without its exact journal), with
the numbers probed first in one rolled-back `DO` block and asserted in the
migration (CLAUDE.md 10.9 and 11.5). Never edit or delete an existing
`spin_reserve_ledger` row: its receipt is immutable by trigger
(`fn_spin_reserve_receipt_is_immutable`) and a settled record is not rewritten
to make a number tidy.

## What not to do

- Do not take anything back from the player; they were paid what the lobby
  advertised.
- Do not add a job that re-books gaps (CLAUDE.md 10.12). Find the writer that
  split the booking from the payout and fix it.

## Where the owning code lives

- Gauge: `server/src/services/SpinMetrics.ts`, SQL `fn_spin_metrics`
  (`bg` CTE), view `v_spin_draw_booking_gaps`.
- Live booking and draw: `fn_spin_draw_and_settle_atomic`; engine side
  `server/src/tournament/SpinDrawReceipt.ts`, `spinDrawSync.ts`.
