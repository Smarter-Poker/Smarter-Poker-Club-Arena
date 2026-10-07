# Deep Stack horses actually sit at the Diamond Arena

**Date:** 2026-10-06 · **Area:** engine, `HorseFleetManager` seeding cycle

## What was wrong

PR #6309 sent the Deep Stack Society (DSS) horses to the Diamond Arena's cash
tables, and the arena's `cash_games_enabled` switch is on. Production still
showed zero seats at all 17 arena tables, and no Diamond custody row for any
DSS horse, so not a single buy-in had ever been attempted.

**The cause.** The arena wallet was built from the chip membership map
(`memberships`): a horse got an arena wallet only if that map already held one
of its `DIAMOND_ARENA_HORSE_CLUBS` memberships. That map only loads the clubs
that own an **open chip table**, plus the Midway pair in `this.clubIds`
(Shark, JAQK). DSS owns no open chip table (all 3,151 of its cash tables are
closed, which is why its horses were sent to the arena in the first place),
and none of its 416 horses belongs to any other club. So no DSS membership was
ever in the map, the derivation skipped every DSS horse, and
`resolveSeatClub` refused every horse at every arena table. The fleet
heartbeat's `no_membership` gate counted them as about 61k pairs per cycle.

What production showed when this was written:

- The arena tables pass `isDiamondArenaCashTable`: all 17 are `waiting`, with
  no cluster or lifecycle, and the arena club is `asset='diamonds'`,
  `is_platform`, with no union.
- DSS horses: 416 `active` memberships, none `disabled`, 0 in another club,
  about 4.2M Diamonds in total (about 10k each).
- The Diamonds can be spent: these horses have no `diamond_purchase_lots` rows
  (so nothing is locked by the 14-day settlement window) and no unsettled
  `diamond_debts`.
- `cash_tables_needing_engine` gives an engine to any occupied table, so arena
  tables start dealing as soon as somebody sits.

## The fix

The arena block now reads its own players: `club_members` of
`DIAMOND_ARENA_HORSE_CLUBS` with the same `active`/`approved` statuses, paged
by `user_id` per club. It pairs them with `profiles.diamonds` through the new
pure `arenaWalletsFor`. Each horse found gets one arena membership and one
arena roll, keyed `${arena}:${horse}`, as before. The block still fails
closed: if either read is incomplete, the arena is skipped for that cycle.
DSS chip rolls are deliberately **not** added to the chip maps, so the chip
floor's host caps, ladder gauge and planners stay exactly as they were.

Pinned in `server/src/services/horsesPlayTheDiamondArena.law.test.ts`. That
test now refuses a derivation that borrows from the chip map, and it shows
that a DSS horse with no chip membership anywhere still gets its arena wallet.
