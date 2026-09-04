# The Free Buy board: five a day, per host, on a Chicago clock

**2026-09-04.** Continues `2026-09-04-free-buy.md`, which built the tiers, the
add-on window and the tier-aware pricing trigger but left the events themselves
uncreated. Nothing published them. This is the pass that does.

## What Dan asked for

> "EVERY 4 HOURS STARTING AT 8 AM, 12PM, 4PM 8PM, 12AM. SO 5 FREE ROLLS A DAY
> $250'S EACH. 8PM IS $500."

Five events a day for each of the two hosts, Midway Union and Deep Stack
Society. First entry free, 3,000 starting stack, paid rebuys, and a
10,000-chip add-on that opens the moment a player sits down and closes after
the break.

## The one thing this pass does differently from every other creator

`HOURLY_SCHEDULE` matches on `now.getUTCHours()` and creates its events at
`now + MTT_PUBLISH_LEAD_MS`. The start time is therefore whenever the tick
happened to fire inside a three-hour UTC block, which is fine for an event
called "Lunch Rush" and wrong for one a player is asked to turn up to.

A Free Buy has to start at 20:00 **Chicago**, on a clock that moves twice a
year. So here the slot decides the start time and the publication lead is
measured backwards from it. `chicagoWallClockToUtcMs` does the conversion in
two passes, because the offset depends on the answer: guess with the offset at
the naive instant, then re-read the offset at that guess and correct.

`FreeBuy.test.ts` pins the failure this prevents: 20:00 Chicago is
`2026-07-16T01:00:00Z` in July and `2026-01-16T02:00:00Z` in January. A
scheduler holding a fixed UTC hour would have moved the feature event to 19:00
every November and back every March, and nobody would have noticed until a
player complained that the big one had gone missing.

Neither DST discontinuity can bite: the spring-forward gap is 02:00-03:00 and
the fall-back repeat is 01:00-02:00, and no Free Buy hour is either.

## The publication lead is three hours, and the number is not a taste

Strictly less than the four-hour cadence, so exactly one Free Buy per host is
ever open at once. Two of them can never compete for the same free horses, and
the lobby never shows a player two identical free events and asks them to
choose. It also clears both windows underneath it: `fn_freeroll_fill_targets`
only looks 90 minutes ahead, and the pre-start ramp's curve is squared over its
72-hour ceiling, so an event published three hours out sits at one entrant
until the last hour and then fills. That is the shape the ramp was tuned for.

## Idempotency belongs to the database

The pre-read in `checkAndCreateFreeBuys` is a courtesy that saves an insert.
The guarantee is `uq_scheduled_tournament_one_live_per_occurrence`, unique on
`(club_id, tournament_type, name, start_time)` while the event is pre-start.
Two engines, two overlapping ticks, or a retry all converge on one event per
(host, slot, Chicago date), and the loser sees 23505, which is the guard
working rather than a failure. The read fails **closed**, like `getActiveCount`:
an unreadable board is not an empty board, and the slot has 36 more ticks.

A slot already past is never created. An engine that was down over 20:00 does
not get to publish a tournament that started an hour ago.

## union_id is not cosmetic

`fn_ca_fund_overlay_on_lock` funds a guarantee from `union_wallets` when
`union_id` is set and from `clubs.chip_treasury` when it is not. Midway Union
stamps both `club_id` and `union_id` with the union id, which is the shape
every house-owned event on this platform has always had. Deep Stack Society is
a standalone club and correctly has none.

Measured 2026-09-04:

| Store                 | Owner                                 | Balance      |
| --------------------- | ------------------------------------- | ------------ |
| `union_wallets`       | Midway Union                          | 66,571.34    |
| `clubs.chip_treasury` | Deep Stack Society                    | 1,889,469.42 |
| `clubs.chip_treasury` | Midway Union (club row, not the bank) | 0.66         |

**A correction to the handoff, from Dan.** That last row was reported as an
emergency: "the Union fallback is empty at 0.66". It is not the Union's money.
The bank that funds a Union overlay is `union_wallets`, and it holds 66,571.34.
Dan, verbatim: "THIS IS FALSE. MIDWAY UNION BANK HAS 66,571.34 CHIPS."

## No horses are registered at creation

Every other creator seeds a field at creation because it publishes 30 minutes
out. This one publishes three hours out, and registering then would hold horses
off the cash floor for three hours for nothing. `GameServer.discoverTournaments`
already ramps every REGISTERING tournament on a squared curve "however it was
created", which puts one entrant on the row immediately and the rest in the
last hour.

## The field is sized to fund its own guarantee

Every entrant takes exactly one add-on (35% at once, the rest at the break),
and the field averages about one rebuy each inside the hour. So the standard
tier breaks even at 125 entrants against a 200 cap, and the feature tier at
167 against 300. `freeBuyBreakEvenEntrants` states the arithmetic and three
tests hold the caps above it. The guarantee is a ceiling on house exposure,
not a cost.

## The four extra freerolls are gone (Dan's call, 2026-09-04)

The previous pass added four $75 freerolls to `HOURLY_SCHEDULE` under the
heading "a freeroll every four hours", because the board carried only two a day
and a broke horse had a twelve-hour gap to cross. That reason is now met, and
met better: the Free Buy board is every four hours on **both** hosts, and
`HOURLY_SCHEDULE` only ever served Midway Union.

Put to Dan with the numbers; he chose to revert them. The two freerolls that
predate this work (03-05 and 15-17 UTC) are untouched. Union now runs two
legacy freerolls plus five Free Buys; Deep Stack Society goes from none to
five, which is the part the old board could never have given it.

The 8-hour overnight gap between 00:00 and 08:00 Chicago is as Dan specified.
It was put to him and he chose to leave it at five.

## Freeze

`checkAndCreateFreeBuys` gates itself on `isMaintenanceFrozen()` before any
I/O, and re-checks inside the loop. It does not move chips itself, but the ramp
registers horses into whatever it publishes within 45 seconds, and `start()`
runs it once immediately, so a boot inside the break must not open a board. It
is pinned in `theFreezeIsTotal.law.test.ts` alongside the other four launchers.

## Verified

Server typecheck clean. Server suite 5,049 passing across 356 files (34 new).
Client suite 12,568 passing. The live overlay-funding balances above were read
from production; nothing was written to it.

## Still not done

The floor planner (`planFloor`) is still not executed by `HorseFleetManager`,
and `horses:tag` has still only ever been run with `--dry-run`.
