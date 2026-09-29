# SpinPrizeUnpaid

Runbook for `SpinPrizeUnpaid` in `infra/monitoring/spin-rules.yml` (group
`spin-money`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-prize-unpaid`, which has never
served anything.

## What it means

```
poker_spin_unpaid_settlements > 0   for: 10m   severity: critical
```

A Spin drew its prize out of the reserve pool and the amount credited to the
winner's wallet does not match. Players are owed money right now.

## What the expression measures

`fn_spin_metrics` counts rows of `fn_spin_unpaid_settlements(24)` with
`chips_short > 0.01`. For each Spin created in the last 24 hours that is not
RUNNING or REGISTERING and has a `spin_reserve_ledger` row of kind
`jackpot_draw`, the function compares the prize drawn (the negated ledger
amount) with the sum of `wallet_transactions` of type `credit`, category
`prize`, `related_entity_id` = the tournament. It keeps a row when the two
differ and either the game ended over ten minutes ago or the draw is over two
hours old, and only when exactly one player finished first and every seat is
ranked. `verdict` is `nobody_paid`, `under_paid` or `over_paid`.

**There is no back-pay sweep any more.** Until 2026-09-26 this alert's
description still told the reader one would clear these. Since
2026-09-10 one transaction, `fn_spin_draw_and_settle_atomic`, books the entry,
draws, settles and writes the receipt together, and the engine refuses to deal
without that whole receipt. The GameServer winner-backpay timer was removed
and `fn_backpay_spin_unpaid_winners` has no caller
(`docs/BAND-AIDS-REGISTER.md`, TIER 1 section 9). Nothing is going to clear
this on its own, and nothing should: a standing count means the atomic path was
bypassed or a later write undid part of it, which is the P0.

## First checks

1. The rows, read-only:
   ```sql
   SELECT * FROM fn_spin_unpaid_settlements(24) WHERE chips_short > 0.01;
   ```
2. For each tournament id, the evidence on both sides:

   ```sql
   SELECT kind, amount, multiplier, buy_in, created_at
   FROM spin_reserve_ledger WHERE tournament_id = '<id>' ORDER BY created_at;

   SELECT user_id, type, category, amount, created_at
   FROM wallet_transactions WHERE related_entity_id = '<id>' ORDER BY created_at;

   SELECT user_id, status, position FROM tournament_players WHERE tournament_id = '<id>';
   ```

3. The engine's view of the launch:
   `docker logs --since 6h club-arena-engine 2>&1 | grep <id> | tail -40`.
   Look for a refused or unknown settlement receipt
   (`spinSettlementReceipt`, `SpinDrawReceipt`) and for a launch that was parked
   (`spinLaunchParking`).
4. Is anything still calling the retired writers? A `wallet_transactions` row
   whose timing does not match the draw, or a `jackpot_draw` with no receipt,
   names the second writer.

## Settling the damage

Under CLAUDE.md 10.9 the agent decides and settles, when all five conditions
hold: the outcome is read from rows (step 2 above), the credit goes through the
platform's idempotent prize path with a per-user key so nobody is paid twice,
nothing is taken back from a player for an overpay our defect caused, the
numbers are proved first in one rolled-back `DO` block (11.5 rule 1), and a
paragraph names every affected player. The migration asserts the probed
numbers so it aborts if the board moved. The known historical incidents were
settled this way, by exact asserted migration blocks rather than a payer job.

## What not to do

- Do not re-enable, reschedule or hand-call `fn_backpay_spin_unpaid_winners`
  or any other sweep as the fix (CLAUDE.md 10.12). Find the path that let a
  drawn prize reach nobody and change that line.
- Do not hand-write a `wallet_transactions` or `club_members.chip_balance`
  row. Never delete a `table_seats` row to clean up (11.5 rule 3).
- Do not claw back an overpay (`over_paid`) from a player (10.9 rule 3).

## Where the owning code lives

- Gauge: `server/src/services/SpinMetrics.ts`, SQL `fn_spin_metrics` and
  `fn_spin_unpaid_settlements`.
- Live settlement: `fn_spin_draw_and_settle_atomic`; engine side
  `server/src/tournament/spinSettlementReceipt.ts`, `SpinDrawReceipt.ts`,
  `spinDrawSync.ts`, `spinLaunchParking.ts`.
- Hourly database-side check: pg_cron `spin_unpaid_check`
  (`fn_spin_unpaid_check(7)`).
