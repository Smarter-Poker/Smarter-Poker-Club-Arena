# 2026-10-23 PLO Cash Tables Get Their Horses

Dan, 12:46 CDT: "plo games are showing 0 players playing... this needs to be
fixed right now!" Then 12:59: "all horses can play the lower stakes plo games
under .10-.25 and .25-.50. make sure thats enabled".

## What Was Wrong

Measured 17:50 UTC: 42 live PLO cash tables in Midway Union and 3 horses
seated across all of them. The lobby count was accurate; the tables were empty.

Only the 15 horses on `ca_horse_plo_roster` (2,000+ PLO hands and a PLO profit
in 30 days) could sit at PLO, at every stake. Those 15 held 46 running
tournament seats and 141 tournament bookings between them, so the four-game
limit (`fn_concurrent_game_load`) kept every one of them off the PLO cash floor.

## What Changed

1. The PLO roster now gates 0.50/1 and up only. A PLO cash table at 0.50 big
   blind or less is open to every cash-roster horse, in the engine
   (`HorsePloRoster.isOpenStakePlo`, read by `HorseFleetManager` and
   `HorseSessionRotator`) and at the database seat door
   (`fn_ca_horse_roster_seat_guard`).
2. `fn_ca_horse_roster_refresh` gives every cash tag on the roster the PLO
   variants and the 0.25 / 0.50 stakes, and the PLO roster also 1 and 2.
3. The PLO roster plays the cash lane: no new tournament registrations, and a
   daily cap of at least 16 hours. A horse leaving the PLO roster goes back to
   lane `both`.
4. Data, 17:57 UTC: the 15 horses set to lane `cash`, and 131 of their pending
   tournament bookings unregistered through
   `fn_ca_unregister_tournament_player_exact` with full refunds. One
   satellite-won entry was kept (its provenance is immutable).

Migration `20261023175910_plo_roster_horses_play_plo_cash.sql`; pinned by
`server/src/services/HorsePloRoster.test.ts`.

## Follow-Up, 19:20 UTC

The first version of the migration was refused by the applier before it
changed anything: 20261023175018 and 20261023182203 (installed from another
branch at 18:25 UTC) had replaced `fn_ca_horse_roster_refresh` with a
five-argument version (the roster sizes itself to the floor; the PLO list needs
5,000 PLO hands at 1 bb/100), so the old four-argument body would have made a
second overload. That refresh also stripped the PLO variants from 41 tags,
undoing the low-stakes opening. The migration is now built on the installed
bodies with only this change's edits, and it no longer strips any PLO tag.

The engine half (low-stakes PLO open to every horse, #7813) ships in the
04:00 America/Chicago daily maintenance: the latest owner instruction is
"Keep 4 AM; no additional break" (#7817). Until then the database side is
live and the PLO list horses, freed from tournaments, fill the PLO tables.
