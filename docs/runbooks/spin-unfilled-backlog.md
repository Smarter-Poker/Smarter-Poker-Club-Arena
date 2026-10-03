# SpinUnfilledBacklog

Runbook for `SpinUnfilledBacklog` in `infra/monitoring/spin-rules.yml` (group
`spin-experience`). Written 2026-09-26, replacing a link to
`https://monitor.smarter.poker/runbooks/spin-unfilled-backlog`, which has never
served anything.

## What it means

```
SpinUnfilledBacklog            poker_spin_unfilled_past_window > 5        for: 20m  warning
SpinHumanWaitingForOpponents   poker_spin_human_oldest_wait_seconds > 60  for: 1m   critical
(both: unless on () max_over_time(poker_maintenance_break_active[6m]) == 1)
```

Changed 2026-10-03. The rule used to read `poker_spin_unfilled_waits > 5`, the
whole population of partly filled Spins. That population is mostly the product
working: a horse-opened board sits at 2/3 holding its last seat for a human for
90-350 s (Dan's rule, `SEAT_FIRST_HUMAN_WINDOW_*`), and ~700 Spins an hour keep
~40 boards there at any instant, so the old rule fired every hour by
construction (12 to 66 overnight 2026-10-02/03, while every Spin created
started and none needed a refund).

- **SpinHumanWaitingForOpponents**: a live HUMAN seat on a partly filled Spin
  has waited over a minute. The seat-first fast lane normally fills a human's
  board in seconds (measured 2026-10-03: 0/3 board, full 8.5 s after the
  seat, RUNNING at 17.5 s), with first claim on free horses. This is the one
  that means a paying player is waiting.
- **SpinUnfilledBacklog**: more than five partly filled Spins whose human
  window (`start_time`) closed over 120 s ago. The last horse normally
  arrives a median 11 s after the window; boards past it mean the fleet is
  not filling (pool exhausted, four-table cap, seat-RPC lock timeouts).

`poker_spin_unfilled_waits` is still emitted and is the population, not an
alarm. `poker_spin_unfilled_oldest_wait_seconds` is the oldest live seat on
any partly filled board.

## What the expressions measure

`fn_spin_fill_waits()` (read by `SpinMetrics` in the same snapshot as
`fn_spin_metrics`; a failed read keeps the last good snapshot and trips
SpinMetricsStale, it is never read as zero): Spins in REGISTERING or ANNOUNCED
with `started_at` NULL and between one live seat and `max_players - 1`:

- `human_unfilled_waits`: those with at least one live non-horse seat;
- `human_oldest_wait_seconds`: the longest such human seat has waited (0 when none);
- `unfilled_past_window`: those whose `start_time` is more than 120 s ago;
- `unfilled_oldest_wait_seconds`: oldest live seat on any of them.

`v_spin_unfilled_waits` keeps `oldest_seat_at`, `longest_wait` and
`chips_locked` per board for the drill-down below.

## A human is waiting

1. Find the board and the human seat, read-only:
   ```sql
   SELECT t.id, t.name, t.start_time, s.seat_number, s.joined_at, now() - s.joined_at AS waited
   FROM tournaments t
   JOIN tables tb ON tb.tournament_id = t.id
   JOIN table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
   JOIN profiles p ON p.id = s.user_id AND NOT coalesce(p.is_horse, false)
   WHERE t.variant = 'spin' AND t.status IN ('REGISTERING','ANNOUNCED') AND t.started_at IS NULL
   ORDER BY s.joined_at;
   ```
2. Engine log: `GameServer.seat_first_human_waiting` ("SEAT-FIRST BOARD CANNOT
   FILL ... (a human is waiting)") names the board and the seats the top-up
   could not fill; the matching `seat-first-precheck` and "seat-first fill
   added nobody" lines say why (four-table cap refusals, lock timeouts).
3. A human's ask draws on the events lanes, then active cash-lane horses, and
   is not held to the cash-room floor; every other claim leaves the seats the
   human needs free (`humanSeatsOwed`). If even that pool is empty the fleet
   itself is exhausted: look at `HorseFleet` "No available horses" and
   `HorseOverlayGuard` lines.

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

## Boards past their window

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

- Gauge: `server/src/services/SpinMetrics.ts`, SQL `fn_spin_metrics` and
  `fn_spin_fill_waits`, view `v_spin_unfilled_waits`.
- Fill: `GameServer.fillPartialSeatFirstGame` (seat-first fast lane),
  `TournamentRecurringService.topUpWithHorses` / `pickFreeHorses`.
- Expiry: `fn_spin_expire_unfilled`, `spin_fill_policy`; engine caller in
  `server/src/GameServer.ts`.
- Launch: `server/src/tournament/spinLaunchParking.ts`,
  `playedSpinLaunchRecovery.ts`, `TournamentManagerBase.ts`.
