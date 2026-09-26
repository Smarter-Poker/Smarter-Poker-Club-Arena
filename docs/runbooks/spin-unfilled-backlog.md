# SpinUnfilledBacklog

Runbook for `SpinUnfilledBacklog` in `infra/monitoring/spin-rules.yml` (group
`spin-experience`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-unfilled-backlog`, which has never
served anything.

## What it means

```
poker_spin_unfilled_waits > 5   for: 20m   severity: warning
```

More than five Spins have sat for twenty minutes open, unstarted and partly
filled. It is a population count. As the rule's own description says, it does
not filter on wait age, on the fill policy or on a booked draw, so it proves
neither that any member is due for expiry nor that the expiry timer failed.
Seated players in these games have paid their buy-in and are waiting.

## What the expression measures

`fn_spin_metrics` counts every row of `v_spin_unfilled_waits`: Spins in
REGISTERING or ANNOUNCED with `started_at` NULL and between one live seat and
`max_players - 1` (default 3). The view also gives `oldest_seat_at`,
`longest_wait` and `chips_locked` (`buy_in_amount * live_seats`).

Measured 2026-09-26 06:50 UTC with the query in step 1 below: 33 rows. 20
were ordinary waits under the 30-minute policy (1,107.00 seated). The other 13
all had a multiplier set and a `jackpot_draw` booked, no
`spin_draw_receipts` row, and had never started; the oldest had waited 17 days
and they held 244.00 in seats. Expiry correctly refuses those (they are drawn),
so the count stays above five until their launch or settlement is resolved.
That tail, not the count, is the part to read.

## How expiry works

A Spin is seat-first: a player pays when they sit. `fn_spin_expire_unfilled`
cancels a Spin through `atomic_cancel_tournament` (which refunds) when a live
seat has waited longer than `spin_fill_policy.unfilled_timeout_minutes`
(30 today; 0 disables it), the game is not full, and **no draw is booked**
(`spin_multiplier` is 0 and there is no `jackpot_draw` ledger row or
`spin_draw_receipts` row). A drawn Spin is never expired: it belongs to its
continuation or settlement authority. The engine calls the function on its own
ten-minute clock (`server/src/GameServer.ts`, "UNFILLED-SPIN REFUND"), and the
World Hub `/api/cron/spin-sweep` route calls it too; the function is idempotent.
The timeout is the product rule, not a repair.

## First checks

1. Split the backlog by what expiry will do with each row, read-only:
   ```sql
   SELECT w.tournament_id, w.club_id, w.live_seats, w.longest_wait, w.chips_locked,
          coalesce(t.spin_multiplier, 0) > 0 AS multiplier_set,
          EXISTS (SELECT 1 FROM spin_reserve_ledger l
                   WHERE l.tournament_id = w.tournament_id AND l.kind = 'jackpot_draw') AS draw_booked,
          EXISTS (SELECT 1 FROM spin_draw_receipts r WHERE r.tournament_id = w.tournament_id) AS receipt,
          w.longest_wait > make_interval(mins => (SELECT unfilled_timeout_minutes FROM spin_fill_policy LIMIT 1)) AS past_policy
   FROM v_spin_unfilled_waits w JOIN tournaments t ON t.id = w.tournament_id
   ORDER BY w.longest_wait DESC;
   ```

   - `past_policy` and no draw: expiry should have cancelled it. Read the
     engine log for `GameServer.spin_expire_unfilled_failed` and the Postgres
     log for `fn_spin_expire_unfilled: could not cancel`; the warning carries
     the refusal from `atomic_cancel_tournament`.
   - A draw booked or a receipt present: the Spin was drawn and never started.
     That is a launch that did not complete, not a fill problem; follow the
     launch evidence (`/health.spinLaunchParks`, the engine log for the id) and
     `docs/runbooks/spin-fleet-stalled.md`.
   - Not yet past the policy: ordinary waiting.
2. The expiry's last result, from the engine log:
   `docker logs --since 1h club-arena-engine 2>&1 | grep -i 'unfilled-spin' | tail`.

## What not to do

- Do not cancel or refund these by hand, and do not call
  `fn_spin_expire_unfilled` or `atomic_cancel_tournament` against production to
  "test" them. They move real chips; a probe is one rolled-back `DO` block
  (CLAUDE.md 11.5 rule 1).
- Do not expire a drawn Spin. A drawn or played game needs its continuation or
  settlement authority, and cancelling it would refund a game whose draw is on
  the books.
- Do not add another sweep. If a class of rows is never expired or never
  launched, the fix is the line that strands them (10.11, 10.12).

## Pinned contract

This rule's exact source block is pinned by
`scripts/ci/check-alert-rules-match.mjs` (`SPIN_BLOCK_SHA256`, `SPIN_CONTRACT`)
and `tests/unit/spinLoadedRuleContract.test.ts`. A change to the rule, including
this runbook path, updates both in the same commit.

## Where the owning code lives

- Gauge: `server/src/services/SpinMetrics.ts`, SQL `fn_spin_metrics`, view
  `v_spin_unfilled_waits`.
- Expiry: `fn_spin_expire_unfilled`, `spin_fill_policy`; engine caller in
  `server/src/GameServer.ts`.
- Launch: `server/src/tournament/spinLaunchParking.ts`,
  `playedSpinLaunchRecovery.ts`, `TournamentManagerBase.ts`.
