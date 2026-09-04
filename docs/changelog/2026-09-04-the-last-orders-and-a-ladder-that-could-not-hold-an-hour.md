# The last two orders, and a Free Buy ladder that could not hold an hour

**2026-09-04.** The planner emitted four kinds of order. Three were already
executed. This wires the last two, and in checking the Free Buy end to end
found that the event as specified would have been over before its own add-on
mattered.

## Seat and open, without a second seating implementation

`planFloor` says a table should be fuller, or that a band has nowhere to play.
The executor must not act on either itself: seating means choosing which horse,
from which wallet, for how much, against a bankroll, a tag, a mutex, a club
membership and a stake ladder, and all of that already exists in one place that
runs every thirty seconds against real money. A second copy would be a second
answer to "may this horse sit here", and this estate has `src/lib/cashBuyIn.ts`
precisely because four layers once disagreed about one buy-in.

So the executor **publishes** and the seeder reads. `StableHandPlanBus` holds
the plan for two cycles and then expires, and an expired bus reads as empty -
which puts every table back on its own per-table target, exactly what a
switched-off controller looks like.

- **Seat orders raise a table's target and can never lower it.** An order that
  could lower one would be a stand, and stands go through the executor where
  the leave path is. The host occupancy cap still binds afterwards, so a shape
  order cannot push the floor past its curve.
- **Open orders are TAKEN, not read.** An order acted on must not be acted on
  again before the executor has re-planned; a table opened twice is the
  duplicate-board bug the recurring service already carries a unique index to
  prevent.

`openPlannedTables` is the only path in the fleet that creates a Stable Hand
table and it is written almost entirely as refusals: one per host per cycle,
never while the controller is off or the platform frozen, **never during the
night window** (opening while the other half of the system parks thin tables is
a controller arguing with itself), never while the host is at its occupancy cap,
and **only when the host has no open table of that game at that stake at all**.
That last rule is what makes it safe: the table count cannot creep, because a
second table of the same game is never opened.

## Then the Free Buy was checked end to end, and the structure was wrong

Dan set three numbers that decide the blind structure together: **3,000 to
start, a 10,000 add-on, and "ONE HOUR FOR LATE REG, THEN THE ADD ON PERIOD"**.
The event had been built on `BLIND_STRUCTURES.TURBO`. Measured:

|                              | TURBO (as shipped) | the Free Buy ladder now |
| ---------------------------- | ------------------ | ----------------------- |
| levels                       | 24                 | 30                      |
| whole ladder                 | **57 minutes**     | 153 minutes             |
| stack at level 1             | 60 BB              | **120 BB**              |
| big blind at the 1-hour mark | **1,500,000**      | 400                     |
| a 13,000 stack there         | **0 BB**           | **33 BB**               |
| levels left after late reg   | **0**              | 19                      |

The house TURBO is 57 minutes end to end, so an hour of late registration
consumes the entire structure. At the moment the add-on Dan specified becomes
available, the big blind is 1,500,000 against a 13,000 stack - the event is a
forced all-in lottery long before the break, and the 10,000 chips are worth
nothing by the time anybody can take them. Lengthening TURBO's levels does not
help: at 1.58x a level the blind is 10,000 by minute 60 either way.

`blindLadder.ts` exists because 38.1% of completed events ended with every chip
in play worth under three big blinds. A Free Buy on TURBO would have joined them
**by design rather than by accident.**

`BLIND_STRUCTURES.FREE_BUY` is 30 STANDARD levels of 6 minutes decaying to 5,
starting at a 25 big blind. **TURBO was not Dan's word** - it came from the
handoff's slot table, with no quote attached, unlike every price in that spec.
His hour is quoted, and the two cannot both be honoured. Four tests pin the new
ladder, and one of them keeps the TURBO comparison rather than deleting it, so
the next agent reads a measurement instead of somebody's taste.

## The Free Buy row, pushed through the live triggers and rolled back

Five triggers rewrite a tournament row on the way in, and one of them exists to
force every 0-buy-in MTT's rebuy and add-on to 1.00. The whole point of the
tier-aware migration is that it must **not** touch a scheduled Free Buy, and
that can only be confirmed on a real row.

All four rows - both slots, both hosts - inserted into production inside a
transaction that was rolled back:

```
Morning Free Buy (NLH)     club fade0000  gtd 250  in 0+0  rebuy 1.00  addon 1.00 x10000
Prime Time Free Buy (NLH)  club fade0000  gtd 500  in 0+0  rebuy 2.00  addon 2.00 x10000
Morning Free Buy (NLH)     club 2a1132b9  gtd 250  in 0+0  rebuy 1.00  addon 1.00 x10000
Prime Time Free Buy (NLH)  club 2a1132b9  gtd 500  in 0+0  rebuy 2.00  addon 2.00 x10000
```

free_buy true, addon_from_start true, late reg 11 levels / 60 minutes,
max_rebuys NULL on every one. **The $500 tier kept its $2 price** - the law
conflict is settled on a real insert, not only in a unit test.

## `npm run freebuy:verify`

The unit tests pin the row the code BUILDS. This reads the row the database
KEPT, for every live Free Buy: tier prices, add-on chips and window,
`addon_from_start`, rebuys closing with late registration, `max_rebuys` still
NULL, the union_id the overlay bank is chosen by, one event per host per slot
per Chicago day, and five a day per host. Exit 1 on any disagreement.

Run now, it correctly reports **nothing to check** - the board does not exist
until this branch merges and deploys. That is the one item on the list that
cannot be finished from here, and the script is what will finish it.

## Four migration filenames corrected, and one collision caught

`migrationVersionUniqueness` failed when main's `chip_continuity_slice_0`
arrived on the same hand-picked round number as this branch's beats migration.
Supabase keys `schema_migrations` on the version, so **of two files sharing
one, the second is silently never applied.**

The beats file is renamed to the version production actually recorded. Checking
the rest of the branch found the same latent problem in four more: every one
carried a round hand-picked number while production had recorded a timestamp.
They did not collide today; they were the next collision waiting. All four now
carry the version the database has:

| was              | is                                                      |
| ---------------- | ------------------------------------------------------- |
| `20260904020000` | `20260904060838_stable_hand_tag_and_state_tables`       |
| `20260904030000` | `20260904063653_free_buy_tournaments`                   |
| `20260904031000` | `20260904064229_overlay_falls_back_to_the_treasury_v2`  |
| `20260904032000` | `20260904065106_free_buy_tiers_may_set_their_own_price` |

The law test that pins the tier migration and the changelog that named the tag
migration were both updated in the same commit.

## Verified

Server typecheck clean, 5,326 tests across 371 files. Client typecheck clean,
12,792 tests. The Free Buy rows were proven against production inside a
rolled-back transaction; nothing was committed to it.
