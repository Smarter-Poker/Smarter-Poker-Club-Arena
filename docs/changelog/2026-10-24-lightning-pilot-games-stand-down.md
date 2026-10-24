# The Two Lightning Pilot Games Stand Down

Dan, 2026-10-24: two horses-only Lightning games were still running in the old Lightning Internal Pilot club instead of Midway: NLH 0.01/0.02 (`56d5d6f0`, Action) and NLH 0.02/0.04 (`681eb9e8`, Madness). Every game launches from Midway Union only (`20261024053530`), so these two stop and close.

## Why it takes three installs

Both games are live Lightning pools: `cluster_mode = 'lightning'`, `always_on`, with 11 and 8 horses on anchor seats and 2 hands dealing in each when read. The platform has one door for each stage, and they have to happen in order:

1. **Drain** (`fn_lightning_operator_control(cluster, 'drain', ...)`). This is the only door out of Lightning. It stops joins and new hands at once. The existing drive then lets every dealing hand settle, puts every pool session back on the anchor seat that player never left, and reverts the game to must_move through the original reversion, which checks the money digest. Nobody is stood up and no wallet is written. These same two games were drained this way on 2026-10-18 in 1.8 s and 89 s. The deadline is 120 s, and a hand that is still dealing is always waited for.
2. **Switch off** (`fn_cash_game_switch_off`, as the owner). This door refuses while the game is in any Lightning state (`lightning_state_requires_operator_drain`). A rolled-back probe showed it refusing both before the drain and immediately after it, because a drain cannot finish inside the transaction that opens it. Once the game is off, the live engine (release `70e8a24a`, which includes #7841 `horsesLeaveSwitchedOffGame`) stands each horse up at the end of its hand through `engine.leaveTable()`. That is the ordinary per-occupancy cash-out into the horse's club wallet, the same path a person takes. `fn_cash_cluster_tick` closes each table once it is empty. The rotator runs every 90 s. A horse that is ahead of its buy-in with stay clock remaining leaves when the clock ends, by the same rule a person follows. When this was read, all 19 seats were free to leave.
3. **Close** (`closed_at`): done once nobody is seated, the way `20261015172330` closed the nine Classic pilot games.

The evidence for steps 2 and 3 is in production. On 2026-10-24 at 05:04 UTC, disabled Lightning game `e48072d8` reverted in 59 s. All 19 of its horses left between 05:04:44 and 05:05:14, and each one has a credited `seat_cashout_receipts` row (1,747.93 in total, matching their stacks). The game went dormant at 05:05:15.

## This change

`20261024201850_lightning_pilot_games_drain_through_the_operator_door.sql` is step 1. Acting as the club owner (`2d1cd6c3`, as `20261015172330` did), it opens one drain on each game with a stable request id each. Before anything is written it requires the exact preimage. Afterwards it asserts both games read draining with Lightning off and are still enabled. Using this transaction's own xid, it also asserts that no other game or drain was written, and that no wallet, treasury, live seat, or table or seat of these games was written either. It creates no database objects and runs in one transaction with `lock_timeout 1s` and `statement_timeout 8s`.

The exact body ran at 2026-10-24 20:20 UTC as a rolled-back probe ending in `RAISE EXCEPTION`. Both drains opened in phase `finishing` (2 hands in flight each, 11 and 8 pool sessions), and the live proof evaluated `true` against the post-install state. `txid_status` reports the earlier probe `aborted`, and no drain or request row persisted.

## Next

Once both drains read `complete` and both games read `must_move` with `lightning_enabled = false`, a second migration switches both games off through `fn_cash_game_switch_off`. It acts as the owner with no PostgREST role (`request.jwt.claims = {"sub": owner}`), which is a migration's own trusted context under `fn_caller_is_engine`. A probe showed this passing the live-session gate, while an `authenticated` claim without a session is refused `SESSION_REVOKED`. When no seat is occupied, a third migration closes both games.
