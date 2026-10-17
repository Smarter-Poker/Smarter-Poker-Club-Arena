# The owner can switch off a running cash game

**Owner approval, 2026-10-17:** "approve the switch-off door".

`cash_games.enabled = false` already meant OPORD 1.4 18.4 everywhere it is read: the fleet does not seat a disabled game (`HorseDisabledGames`), `fn_cash_game_join` refuses it, and `fn_cash_cluster_tick` closes each of its tables only once nobody is seated. Nothing authenticated could set it on a game that was in use. `fn_close_managed_game` sets it only by closing the main table, and that refuses while anyone is seated, so a game that players keep arriving at could never be switched off by its owner.

That blocked the private Lightning pilot. The replaced nine-seat Madness held 5 to 9 seated all day, and its six-seat replacement needs the same one-per-key and one-per-band stake slot (setup run 39039493193 refused with seated players, as designed).

`fn_cash_game_switch_off(game, request_id, reason)`:

- club game-creating authority only, live session required, a reason of at least 12 characters;
- refuses any Lightning state (`lightning_enabled` or a cluster mode other than `must_move`); those drain through the operator door first;
- sets `enabled = false` and writes one `game_switched_off_by_owner` event carrying the actor, reason and seated count;
- never stands anyone up, moves a seat, touches a stack, closes a table or writes money;
- replays the same answer for the same request id, and refuses a reused id with another actor or reason.

Pilot setup now retires a replaced target through this door with one stable request id, reads it back off, then creates the replacement. Seated players finish and cash out normally; the controller closes the old tables as they empty.
