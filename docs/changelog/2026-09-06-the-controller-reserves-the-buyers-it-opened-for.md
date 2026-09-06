# The controller reserves the buyers it opened a feeder for - and a booking is a game

2026-09-06. Engine only; no migration.

## The measurement that started this

Feeders over the four hours to 04:20 CDT: **26 opened, 15 went live, 15
abandoned.** Better than the 14 percent of the day before (two fixes had
landed: an opening feeder is abandoned at six minutes rather than three, and
the fleet re-reads a table's lifecycle before seating so it stops spending
horses on a door that shut), but more than half of the tables this platform
opens for players still die empty.

The brief was to build a reservation: a table opened on the strength of N
buyers gets first claim on those N buyers until it is live or abandoned, the
same courtesy OPORD 1.4 18.3 already gives a lone human with its 60-second
`table_opening_hold`. That is built, and it is section 2 below.

But the reservation is not what was killing the feeders. The evidence said
something else, and this is what it said.

## What the evidence said

The `opening feeder` diagnostic line, three hours of it from the live engine:

```
opening feeder "NLH 0.25/0.50 Madness Feeder": candidates 6, sittable 5, wanted 6,
  empty seats 6, selected 4, seated 0, skipped {aggregate_exposure=1}
opening feeder "NLH 0.50/1 Classic Feeder": candidates 18, sittable 17, wanted 2,
  empty seats 2, selected 2, seated 0, skipped {aggregate_exposure=1}
```

Aggregated over the 51 lines in those three hours:

|                              |     |
| ---------------------------- | --- |
| opening-feeder cycles logged | 51  |
| horses SELECTED for them     | 156 |
| horses actually SEATED       | 34  |
| cycles that seated NOBODY    | 30  |

The feeder was already being served first. It had candidates. It cleared them
through the sit verdict. It selected them. And then the buy-in failed, 122
times out of 156, and **the engine log said nothing at all** - because
`seatHorse` deliberately does not report seven refusal messages, on the
grounds that a seeding race is not an incident.

The Postgres error log, same window, grouped by message:

```
10,577  FOUR TABLE LIMIT: user <uuid> is already committed to N games and may not take another
 4,362  solved_spots_gold requires a validated artifact ...
 2,111  invalid column for filter id
    27  TABLE_CLOSING ...
    13  VPIP_BARRED ...
    12  TABLE_SIZE: table is full ...
```

`FOUR TABLE LIMIT` is the most common error on the entire database, by a
factor of two over everything else, and not one line of it reaches the engine
log.

### Why the fleet could not see it

`fn_enforce_four_table_limit` fires BEFORE INSERT on `table_seats` and asks
`fn_concurrent_game_load`, which counts **two** things:

1. every live seat at a table that is not closed, and
2. every booking for a tournament that has not started - a
   `tournament_players` row in `registered` or `playing` whose tournament is
   `ANNOUNCED` or `REGISTERING` - except where the player already holds a seat
   at one of that tournament's own tables.

The fleet counted only (1). Read from production at 09:45 UTC:

|              | horses    | at the DB's four-game limit |
| ------------ | --------- | --------------------------- |
| 0 live seats | 603       | 172                         |
| 1 live seat  | 291       | 94                          |
| 2 live seats | 85        | 57                          |
| 3 live seats | 19        | 17                          |
| 4 live seats | 2         | 2                           |
| **total**    | **1,000** | **351**                     |

**Two** horses were at four live seats, which is all the fleet's arithmetic
could see. **351** were at the database's four-game limit, and **349 of those
looked completely free from the engine.** 2,109 tournament bookings, 2.11 per
horse, invisible.

And the seeding loop makes it worse than 35 percent by design: "four tables is
the target, not the ceiling" weights a horse that is already playing at 4
against 1, and those are exactly the horses most likely to be booked as well -
67 percent of the horses at two seats and 89 percent of those at three were at
the limit. Hence 122 of 156.

So the chain was: the fleet reports N buyers -> the controller opens a feeder
for them (18.3) -> the fleet selects those very horses for it -> the database
refuses every one of them -> six minutes later, `feeder_abandoned`.

## What changed

### 1. A booking is a game (`server/src/services/HorseGameLoad.ts`, new)

A pure module holding the platform rule, mirroring `fn_concurrent_game_load`:
`buildBookingLoad` counts bookings exactly as clause (2) counts them,
including the "never both" exclusion (36 of 2,148 bookings on the day), and
`remainingGameCapacity` returns the tighter of the horse's own cash ceiling
(its tag: a grinder carries four, a mixer one) and the platform's four-game
limit.

The fleet reads the bookings once per cycle, paged and keyset like every other
loader, together with the tables of unstarted tournaments so a seat-first game
is never counted twice. It **fails open**, like the bankroll, rejoin and
disabled-game loaders: a cycle that cannot read them counts none and behaves
exactly as every cycle before today did, with `beat.bookingsReadFailed` and a
warning saying so. The database is still the guard.

The candidate filter asks the one predicate before it looks at the seat map,
because a horse with no seat at all can be committed to four tournaments - 172
of the 603 idle horses were. The refusal is counted (`bookedOutDropped`) and
printed, so it can never be silent again.

**This is not a horse rule (CLAUDE.md 10.5).** `fn_concurrent_game_load`
counts a human's bookings identically and its own HINT says so: "This limit
applies to players and horses alike". A human reads the lobby and knows they
are committed to four games. The fleet is the horse's browser; this is how it
reads the same thing. Nothing here denies a horse anything a human gets - it
stops the fleet promising a buyer the database will refuse, for either of them.

### 2. The feeder reserves the buyers it was opened for (`HorseBuyerAllocation.ts`)

`BuyerPool` now carries an explicit `claim`:

- `reserved` - an opening feeder. Walked **first**, whatever order the caller
  hands the tables in, and capped at the two seats 18.3 promotes it at, so a
  feeder can never strand the floor.
- `seating` - a table with real open seats, in the caller's order.
- `probe` - a full cluster table asking only whether two buyers exist.

Before this, an opening feeder was served first only as a side effect of the
fleet's sort (`lifecycle === 'opening'` ranks -1), which said nothing about how
much it was allowed to claim and which the caller could reorder without
noticing. The claim is stated now, and the pin that used to assert the sort
order asserts instead that reversing the walk does not change the answer.

A probe still consumes capacity, and must: the whole point of the 2026-09-05
fix is that two spare horses are two buyers ONCE, not two buyers in every full
game on the floor. What it may no longer do is book a **second** set of horses
for a game whose feeder already holds a reservation - the tick refuses to open
while one is `opening` (`v_open_unreserved` counts its seats), so those horses
were reserved for a decision that could not be taken and were taken away from
other games' feeders. A game with a reservation now reports the reservation.

**Nothing is stored.** The claim is derived from `tables.lifecycle` every
cycle, so it cannot outlive the feeder: the moment the row stops being
`opening` - live or abandoned - the caller stops passing `reserved`, and a
cycle that dies half way through leaves no state to leak.

**A human waitlist is untouched.** The controller adds `v_waiting` (the humans
on the game's waitlist) to whatever this returns; the allocation never sees a
waitlist row, so no reservation can take a seat from a person or change the
number a person contributes.

### 3. A refused buy-in says why (`HorseBuyInRefusal.ts`, new)

The seven quiet refusals are a counter now, never a silence.
`classifyBuyInRefusal` maps the database's message to a short token,
`seatHorse` hands it back on every refusal path (including the maintenance
freeze), and the seeding loop folds it into two places: the per-cycle line
(`buy-in refused: four_game_limit=122 ...`) and the opening-feeder diagnostic,
as `skipped {buyin_four_game_limit=4}`.

The diagnostic line also carries the reservation:

```
opening feeder "<name>": candidates N, sittable N, wanted N, reserved N,
  empty seats N, selected N, seated N, skipped {...}
```

## Pins moved, in this commit, with their reasons

- `theFreezeIsTotal.law.test.ts` - same gate, same position, block form
  accepted because it also reports 'frozen'.
- `theFloorIsFull.law.test.ts` "four is still the hard ceiling" - the tag
  ceiling is `ownCashCeiling` inside the one predicate, and the platform's four
  is pinned in `HorseGameLoad.ts`. Stricter than before, not weaker.
- `TheTablesOpenAndCloseThemselves.law.test.ts` - the full-table probe is
  unchanged; the `reserved` branch is pinned beside it.
- `aBarredHorseIsNotABuyer.test.ts` - capacity is `remainingGameCapacity`.
- `HorseSitVerdict.test.ts` - the diagnostic line carries `reserved`.
- `HorseBuyerAllocation.test.ts` - the ordering pin became a claim pin: the
  same board reversed must give the same answer.

## How to verify

The ratio, in the hours after the next `:55` cutover:

```sql
select date_trunc('hour', at) h,
       count(*) filter (where kind = 'feeder_opened')    as opened,
       count(*) filter (where kind = 'feeder_live')      as live,
       count(*) filter (where kind = 'feeder_abandoned') as abandoned
  from cash_cluster_events
 where at > now() - interval '12 hours'
 group by 1 order by 1 desc;
```

Baseline to beat: 26 / 15 / 15 over four hours (and 81 / 12 / 69 over six
hours the day before). Success is `feeder_live / feeder_opened` well above a
half, with `feeder_opened` itself FALLING - the fleet should now decline to
report buyers it cannot deliver, so fewer feeders should be opened at all, and
the ones that are should fill.

The engine log says the same thing without a database:

```bash
docker logs --since 1h club-arena-engine 2>&1 | grep "opening feeder"
docker logs --since 1h club-arena-engine 2>&1 | grep "buy-in refused"
docker logs --since 1h club-arena-engine 2>&1 | grep "four-game limit"
```

`seated` should now track `selected` on the feeder lines, and
`buy-in refused: four_game_limit=...` should collapse from the 10,577-per-four-
hours it was measured at. If it does not, the number is now printed where the
next agent can see it, which it was not before today.

## One thing found on the way, NOT changed here, for whoever picks this up

`fn_concurrent_game_load` counts a booking as a game from the moment it is
made, however far away the tournament is. Read at 09:53 UTC, of 2,249 live
bookings: 1,099 were for a tournament starting inside 12 hours, 740 inside a
day, and **396 were more than a day out, up to 69 hours**. So a player who
registers for Tuesday's event is, by this rule, "committed to a game" and
gives up one of their four seats until Tuesday.

That is the database's rule and it applies to humans exactly as it does to
horses, so making the fleet agree with it - which is all this change does - is
unambiguously correct. Whether the rule itself should count a booking three
days out is a different question, it changes what every player is allowed to
do, and it is not an agent's to decide on its own. It is written down here
rather than quietly adjusted. If it is changed, it is changed in
`fn_concurrent_game_load` for everybody, and `HorseGameLoad.ts` follows it in
the same commit - the whole point of this file is that the two cannot drift.
