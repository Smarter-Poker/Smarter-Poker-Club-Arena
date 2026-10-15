# Lightning Pilot Classic Games Are Closed

## Ruling

Dan, 2026-10-15 12:19 Central: "Approved: close the 9 empty Classic games in the Lightning pilot club."

## Why

The Lightning Internal Pilot was created with the default Classic board: nine 0.50/1.00 cash games. Nobody played them, but an enabled game is stake supply to the horse fleet (`HorseFleetManager` builds `bandsWithAGameByHost` from every open table of an enabled game). The pilot therefore read as having a low band game, so its low and mid band horses never projected down to the micro Lightning pilot games (`projectStakeBandOnto` steps a horse down only when its own band has no game on that host). That is why the pilot fill stalled at 8 and 8 against the 18 and 27 live players Phase 3 needs.

## Change

Migration `20261015172330_lightning_pilot_classic_games_are_closed.sql` closes the nine games by id, the way `fn_close_managed_game('table', main)` closes a cluster game: `enabled=false`, `state='dormant'`, `closed_at`, `closed_by` the club owner, and every table of the game closed. When a main table is still open the door itself is called as the owner. The 16:55 UTC owner wallet reset had already closed every main table, and on a closed table the door answers `already_closed` and leaves the game enabled (the cluster tick would reopen it), so the game row gets the door's own write.

The migration refuses whole on any seat, active session or waitlist entry, and asserts that both Lightning Pilot games, every game outside the pilot club, the pilot wallets and the pilot treasury are unchanged.

## Proof

Rolled-back probe at 17:25 UTC (one self-aborting `DO` block): door calls 0, pilot wallets 14,516.14 unchanged, treasury 84,830.64 unchanged, all nine games closed, both pilot games unchanged.
