# A Classic Game Never Moves Its Players

Dan 2026-10-24: "THIS HAS GOT TO BE FIXED AT ONCE, PLAYERS SHOULD NOT BE MOVING ON CLASSIC GAMES PERIOD. FIX THAT BUG AT ITS ROOT CAUSE AND PREVENT IT FROM HAPPENING AGAIN."

## Cause, read from rows

50 Classic games were enabled. 24 had `must_move = false` and never moved anyone. The other 26 (Midway Union's Classic lineup, 188 Main tables and 26 feeders) carried `must_move = true`, so `fn_cash_cluster_tick` planned automatic moves for them every 5 seconds:

- `must_move`: an open Main seat drew the longest-seated feeder player, as seen at PLO6 0.10/0.25 Classic Main 5 at 21:04 UTC;
- `break`: the newest table whose players fit elsewhere was broken and its players moved;
- `balance`: `fn_cash_cluster_balance` evened the feeders.

`must_move` is also the capability that manages a game's tables (Main 1 always open, a new table when every seat is taken, empty tables closed). Turning it off would have stopped those games opening tables, so the fix removes the moves, not the management.

## Fix (`20261024213758_a_classic_game_never_moves_its_players.sql`)

- `fn_cash_game_never_moves_players(template, ruleset)`: Classic, except the PLO5 1/2 Madness stand-in (`rules_profile = madness_without_lightning`).
- `fn_cash_cluster_tick` for a Classic game:
  - plans no must-move;
  - picks only an empty table to break;
  - withdraws a break already started under seated players, putting the table back to live with nobody moved;
  - still opens tables, keeps Main 1, closes empties and honours a player's own seat-change request.
- `fn_cash_cluster_balance` plans nothing for a Classic game.
- Prevention: a trigger on `cash_seat_moves` refuses any move except `seat_change` for a Classic game, so no planner, present or future, can move a Classic player.
- Already-planned automatic Classic moves are cancelled (`classic_game_never_moves_players`). No seat, stack, wallet or hand is touched.
- `fn_cash_game_lobby`'s game object carries `never_moves_players` from the same definition. The on-table lobby is then the "Game Lobby" for a Classic game, with no Must Move List, no "You Are Number N On The Must Move List" and no Must Move figure. The tables, the waiting list and the player's own seat change stay. The patch adds exactly one key: the rolled-back production probe compared the lobby answer with the live one and found it identical apart from the new key and the `as_of` clock.
- `fn_cash_game_join` fills a Classic game's fullest table with an open chair first, whatever its role (Dan 2026-10-23: "A FULLER TABLE FILLS FIRST"). Feeder-last only made sense while the tick moved a feeder's players up; with no moves it would have left a feeder's players short-handed for good. Every other game keeps its order. Found in the wiring sweep; the patched door compiled in a rolled-back production probe and refused an unauthenticated call at its first door, as live does.
- The board reads the game's rules profile in its cluster embed (`rules_profile:ruleset_snapshot->>rules_profile`), and `src/config/classicNeverMovesPlayers.ts` mirrors the SQL definition.
- The lobby card no longer says MUST MOVE / "Seats Open On A Main Pull Players Off The Feeder" on a Classic game; it says CLASSIC. The Madness stand-in keeps MUST MOVE.

## Proof

- Every anchor occurs exactly once in the live bodies (pre-images: tick `801638ba`, balance `3c4b563f`).
- The patched tick, built from this file's own patch code as a `pg_temp` function, ran on the 8 busiest Classic games in production inside rolled-back sub-transactions. It compiled, returned `ok` on every game not mid-tick elsewhere, and planned no move.
- The trigger and the cancellation were run against local copies of the tables. Classic `must_move`, `break`, `balance` and a rewrite of a seat change were refused; a Classic `seat_change`, the Madness stand-in, Madness and Action were admitted.

Pinned by `tests/a-classic-game-never-moves-its-players.law.test.ts`.
