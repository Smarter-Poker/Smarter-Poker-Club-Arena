# A Person On A Lightning Game List Gets A Chair (2026-10-22)

## What Was Wrong

Verified read-only on 2026-10-22 around 09:15 UTC:

- Lightning pilot games `56d5d6f0` (NLH Action 6) and `681eb9e8` (NLH Madness 6)
  are `must_move` Clusters with `cluster_mode = 'lightning'`. Every live seat
  was a horse: Action 3 tables and 18 of 18 seats, Madness 2 tables and 12 of 12.
- `fn_cash_cluster_pool_health` for Action reported
  `population.excluded.waitlist_only = 1`, and `cash_game_waitlist` held one
  live `waiting` row for that game. (At the moment of the check that row
  belonged to an `is_horse` account, which this change correctly ignores; a
  person in the same row is the case this change serves.)
- A player who uses a Cluster's door (`fn_cash_game_join`) when no chair is open
  is put on the GAME list, `cash_game_waitlist`, not on any table list.

Two halves of one gap:

1. `fn_cash_cluster_tick` returns `lightning_cluster_stands_down` for a
   Lightning Cluster, so the tick never opens a feeder for the game list the
   way it does for an ordinary must-move game.
2. The human-yield rule ("a horse gets up when a real person is waiting", Dan
   2026-09-02) read only `table_waitlist`: `HorseFleetManager.humansWaitingByTable`,
   `HorseSessionRotator`'s `humansWaiting`, and `StableHandSnapshot`'s
   per-table waiting count. So no horse ever stood up for a game-list person.

## What Seats Them

Nothing new. `fn_offer_open_seat` already runs on every cash-out
(`atomicCashout` then `notifyWaitlistSeatOpen`, including a leave deferred
behind a live Lightning hand, which completes through `processLeavePending`
and the same `atomicCashout`). When the table list is empty it falls through
to the game list and holds the chair for its FIFO head (installed by
`20261020201931_unattended_cash_game_offers`). That door does not read
`cluster_mode`. What was missing was the vacancy.

## The Change

`server/src/services/HorseGameWaitlistYield.ts` attributes each countable
game-list person to exactly one table, and the three existing readers add that
count to their table-list counts. Every existing yield path then runs
unchanged: the rotator's certain departure (`releaseWanted`), the fleet's
occupancy target, and Stable Hand's `human_yield` with `yieldCount`, all
through the engine's own hand-boundary-safe leave.

The rules, each mirroring the door that will seat the person:

- Only an enabled game whose tick does not open tables for its list
  (`cluster_mode` other than `must_move`, or a manual game). An ordinary
  must-move game is already served by its tick and is not counted again.
- Never a horse.
- Never twice: a person already on one of the game's table lists, or already
  seated in the game, is not counted from the game list.
- `waiting` rows within the offer's 24 hour entry window; `notified` rows for
  the three minutes the ordinary tick allows before expiring them.
- Exactly one table per person: the game's live table holding the most
  horses, ties by id.
- Fails closed: an incomplete read of the game list, its games or its horse
  set asks nobody to leave that cycle (Stable Hand leaves the host out, as for
  an unreadable table list).

No migration, no new timer, no kill switch, no money path change.

## Proof

- `server/src/services/HorseGameWaitlistYield.test.ts` (18 tests): the pure
  attribution, and the rotator, fleet and Stable Hand readers driven through a
  fake PostgREST. A Lightning game with every seat a horse and one person on
  the game list asks exactly one horse on one table (the rotator), reads as one
  person waiting at that table (the fleet), and plans `yieldCount(1)` yields on
  that one table only (Stable Hand). A horse waiter, an ordinary must-move game
  and an incomplete read each ask nobody; table-list behaviour is unchanged.
  Five of these fail against the previous readers.
- `scripts/ci/test-unattended-cash-offer-postgres.py` gains a Lightning case on
  native PostgreSQL 17: with `cluster_mode = 'lightning'`, a vacancy offers the
  chair to the game list's FIFO head, holds it at that table and marks the game
  row `notified`.
