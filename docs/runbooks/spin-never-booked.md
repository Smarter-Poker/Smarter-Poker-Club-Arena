# SpinDrawNeverBooked

Runbook for `SpinDrawNeverBooked` in `infra/monitoring/spin-rules.yml` (group
`spin-money`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-never-booked`, which has never
served anything.

## What it means

```
poker_spin_draw_unbooked > 0   for: 15m   severity: critical
```

A Spin started in the last 24 hours ran, has players, carries a multiplier,
and has **no `spin_reserve_ledger` row at all**. The prize reached the players,
but the pool's books do not contain money that left it, so every reserve total
and every thin-pool decision is wrong by that amount.

Zero is the normal reading. Since 2026-09-10 the launch that deals a Spin books
its entry, draws, settles and writes the receipt in one transaction
(`fn_spin_draw_and_settle_atomic`); 0 of 37,391 draws after that date lacked a
receipt when the sweep was retired. One standing for fifteen minutes means that
transaction was bypassed. Treat it as a P0 and find the writer.

## What the expression measures

The `ub` CTE of `fn_spin_metrics`: tournaments with `variant = 'spin'`, status
RUNNING or COMPLETED, `buy_in_fee` 0, `spin_multiplier > 0`, a club, started
in the last 24 hours, at least one `tournament_players` row, and no
`spin_reserve_ledger` row with that `tournament_id`. The same count per club is
`unbooked_24h` in `v_spin_reserve_health`.

## First checks

1. Which Spins, read-only:
   ```sql
   SELECT t.id, t.club_id, t.status, t.buy_in_amount, t.spin_multiplier,
          t.started_at, t.ended_at
   FROM tournaments t
   WHERE t.variant = 'spin' AND t.status IN ('RUNNING','COMPLETED')
     AND coalesce(t.buy_in_fee, 0) = 0 AND coalesce(t.spin_multiplier, 0) > 0
     AND t.club_id IS NOT NULL AND t.started_at > now() - interval '24 hours'
     AND EXISTS (SELECT 1 FROM tournament_players tp WHERE tp.tournament_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM spin_reserve_ledger l WHERE l.tournament_id = t.id)
   ORDER BY t.started_at DESC;
   ```
2. How each one got a multiplier without a draw row: the engine log for its
   launch (`docker logs --since 24h club-arena-engine 2>&1 | grep <id>`), and
   whether the multiplier was written by something other than the atomic
   receipt.
3. The World Hub route `/api/cron/spin-sweep` still calls
   `fn_spin_sweep_unbooked` from Open Claw at minutes 7, 22, 37 and 52
   (`docs/BAND-AIDS-REGISTER.md`, TIER 1 section 9). If you read that job,
   read its response body, not its exit status: the dispatcher logs "executed
   successfully" for an HTTP 500, and `remaining` in that body is this same
   number.

## Likely causes

- A launch path that assigns `spin_multiplier` or deals without the atomic
  receipt (a recovery or replay path is the usual suspect).
- A migration or rolling cutover that left an older draw function reachable.

## What not to do

- Do not treat the World Hub sweep as the fix, and do not add a pg_cron
  schedule for `fn_spin_sweep_unbooked` back. The pg_cron `spin_sweep_unbooked`
  schedule was retired on 2026-09-22 by `20260922155223` for exactly this reason
  (CLAUDE.md 10.12). The fix is the writer that bypassed the transaction.
- Do not hand-insert reserve rows; the receipt trigger
  (`fn_spin_reserve_row_requires_exact_journal`) refuses a row without its exact
  journal, and a hand-written row is how the books diverged before.

## Where the owning code lives

- Gauge: `server/src/services/SpinMetrics.ts`, SQL `fn_spin_metrics` (`ub` CTE).
- Live booking: `fn_spin_draw_and_settle_atomic`; engine side
  `server/src/tournament/spinSettlementReceipt.ts`, `SpinDrawReceipt.ts`,
  `playedSpinLaunchRecovery.ts`.
- Register entry for the remaining compensation: `docs/BAND-AIDS-REGISTER.md`.
