# Every Horse Is A Diamond Arena Player

Dan, 2026-09-10: "start linking and giving all the horses across all clubs
access to the diamond arena. they need to be able to fully play in the diamond
arena, just like they can in the club arena."

This is the engine half of that, and a rolled-back probe that names exactly
what still stands between a horse and its first diamond hand. Nothing here
opens a table, flips a door, or moves a diamond.

## What the fleet does now

The Diamond Arena is the platform's own room. Every platform user is a member
by entitlement (the approved product contract), there are no membership rows
to read, and ruling 16 says a horse there "must use diamond-only funding". So:

- **The fleet may seat the arena.** `HorseFleetFundingBoundary` used to keep
  the fleet out of every diamond table ("treasury-funded fleet seats belong
  only to authoritative chip arenas"). The boundary that survives is the
  wallet, not the room: `fleetFundingFor` answers `chips` for a chip club or
  union table, `diamonds` for the platform arena, and null for anything whose
  arena cannot be read (that table gets no horse). The seeding cycle filters
  on `isFleetTable`.
- **Every horse is an arena member, and its own diamonds are its roll.** After
  the `club_members` bankroll read, the cycle derives the arena for every
  horse in the pool: the roll is `profiles.diamonds` (read with the pool, one
  column, no second query), keyed on the arena club exactly as a chip roll is
  keyed on its club. `resolveSeatClub`, the bankroll gate, the rejoin floors,
  the exposure cap and the buy-in sizing all work unchanged; the arena is one
  more club every horse holds a roll in. A fail-open cycle (bankrolls did not
  load) leaves the arena unknown too, so the database decides alone, as it
  does for every club that cycle.
- **A diamond buy-in is whole.** `fn_poker_diamond_buyin` refuses a fraction,
  so `computeHorseBuyIn` rounds an arena buy-in to a whole number inside the
  table's limits. Chip seats keep their cents.
- **A diamond seat carries a receipt key.** The horse goes through the same
  `atomic_table_buyin` door a human does; for a diamond table the database
  routes it to `fn_poker_diamond_buyin`, which requires `p_idempotency_key`.
  The fleet now sends a fresh uuid on a diamond seat (and another on the
  rejoin-floor retry, a different amount being a different purchase). Chip
  seats send null, exactly as before.
- **A busted horse leaves through the human door.** On a diamond table there is
  no treasury rebuy and no add-on yet, for anyone. The horse recovery passes
  already return before touching a diamond table, and `standUpBustedCashPlayers`
  excluded horses, so a busted horse would have sat at zero for ever. It now
  waits out the same grace a busted human does and leaves through
  `releaseBustedSeat`; the fleet re-seats it later with a fresh buy-in from its
  own diamonds.

Measured before writing it: 1,000 horses hold 3,063,148 diamonds (p10 2,645,
median 2,962, p90 3,301) and 971 of them earned 101,917 in the last 24 hours
from their own challenge claims. Every horse can cover a 1/2 or 2/5 diamond
seat at its bankroll policy's share of roll.

## What still stands between a horse and its first diamond hand

Proven in one transaction, rolled back by its final RAISE (`/tmp/dc-probe.sql`
on the Mac; the script creates nothing that survives):

```
1 plain diamond table (no game):  REFUSED 23514 tables_cash_needs_a_game
2 fn_cash_game_ensure on the arena: game ... with 1 table(s)
   table rake=-1.00 bbj=100.00 cluster=<game> status=waiting
3 horse diamond buy-in on that table: REFUSED 23514 diamond_plain_cash_table_required
4 clearing cluster_id on the open table: REFUSED 23514 tables_cash_needs_a_game
```

Two written contracts collide, and no table shape satisfies both:

- **Gate 7** (`20260905034937_gate_7_every_cash_table_is_a_game`, OPORD 1.4
  s18): an open cash table must belong to a game (`tables.cluster_id ->
  cash_games.id`). All 143 open cash tables do.
- **Phase 6 admission** (`fn_poker_diamond_buyin`, `assertDiamondCashTable`):
  a diamond table must have `cluster_id IS NULL`, `rake_percent = 0` and
  `bbj_percent = 0`. The game maker also stamps a chip rake (-1, inherit) and
  a 100% BBJ share on the table it opens.

That is not a horse problem: a human cannot buy into a diamond table either.
It is a Phase 6/7 question for the Diamond programme, and under CLAUDE.md
10.8 two written standards in conflict go to Dan rather than to a third law.
Recommendation: let the admission accept a table whose game is a single Main
table (a cluster of one, no feeders, no must-move until Phase 7 certifies
seat moves against custody), and have the arena's game maker stamp rake 0 and
BBJ 0 for a diamonds club.

Also still closed, and Dan's:

- `ca_arena_settings.cash_games_enabled` is false. It is the one door for
  everyone, horse and human alike, and it is gated by the existing accounting
  release condition (seven clean days on the diamond trial balance).
- No diamond stake ladder has been approved. Proposed, sized to the fleet's
  rolls above and to 1 diamond = 1 cent: NLH 1/2, 2/5, 5/10 and 10/20
  diamonds (max buy-ins 200 / 500 / 1,000 / 2,000). That is a price and stays
  Dan's call (10.9).
- Diamond tournaments (the freerolls) are Phase 8: `fn_register_horse_for_
  tournament` funds from the chip treasury and the fleet's tournament pool is
  membership-scoped. Both need the same "the arena is everyone's club, funded
  in diamonds" treatment when that phase lands; nothing was changed there.

## Verification

Server TypeScript clean. `HorseFleetFundingBoundary.test.ts` rewritten to pin
the new rule (the old pin said the opposite and is replaced in this commit,
with the ruling quoted). Green: `DiamondCashBoundary`, `HorseBankrollWiring`,
`StableHandSeatingWiring`, `CashoutEvictionOutcome`, `SitOutClockAndEviction`,
`theFreezeIsTotal.law`, `RebuyRowCannotBeErased`, `PendingAddOnIdleSweep`,
`CashoutDepartureIntegration`, `horseFundingReceipts` (122 tests). The live
probe above ran as a single self-aborting `DO` block (CLAUDE.md 11.5).
