# Classic PLO5 plays at a 50% VPIP floor

Dan, 2026-10-24: "just make the plo5 classic to 50% vpip and stop. thats it.
then relaunch the game." Scope confirmed as every PLO5 Classic game.

The live change was installed by
`20261024213131_plo5_plo6_classic_fifty_vpip_bb_ante.sql` (#7942), a later
owner instruction covering PLO5 and PLO6 Classic, 50% VPIP and a BB ante. It
set the template floor, re-stamped every PLO5 Classic game and projected the
floor onto the running tables, so the games carried on with players seated and
the floor applied from the next hand.

`20261024212524_plo5_classic_plays_at_a_fifty_percent_vpip_floor.sql` (#7938)
merged first with its own template replacement, which had no ante for PLO5
Classic. Installing it after #7942 would have undone the ante (its md5 guard
would have refused it anyway). It was never installed, so it was rewritten as a
read-only proof of the owner's request before being installed: the template
promises 50% over 10 hands, every PLO5 Classic snapshot says 50, and every open
table of an enabled game enforces it.

Verified live 2026-10-24 23:04 UTC: 17 non-closed PLO5 Classic games at 50,
6 enabled, all 15 open tables at `nit_game`, 50%, 10 hands, 60 players seated.

The Classic template blurb in `src/config/cashGames.ts` still reads "No Minimum
VPIP" for Classic in general; a PLO5 Classic game's own info rows read the
snapshot and print "50% Over 10 Hands".
