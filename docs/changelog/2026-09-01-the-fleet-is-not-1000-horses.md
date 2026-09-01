# The fleet is not 1000 horses (2026-09-01)

Four of the day's fleet findings -- 417 idle horses, 156 open cash seats,
17,398 in overlays, 8 near-empty freerolls -- were reported as separate
problems. They are not four problems. Two are detector bugs and the rest are
one capacity fact.

## 1. `fleet_idle_share` counted horses that are switched off

The finding read "417 of 1000 horses dealt no hands", CRITICAL, recommending
an investigation of the seeding cycles. Split by `horse_status`:

| status    | lane   | horses | idle all day |
| --------- | ------ | ------ | ------------ |
| available | both   | 200    | 0            |
| available | cash   | 192    | 0            |
| available | events | 192    | 1            |
| disabled  | both   | 142    | 142          |
| disabled  | cash   | 137    | 137          |
| disabled  | events | 137    | 137          |

**416 of the 417 are disabled.** They are idle because they are switched off.
The seeder was doing its job: 583 of 584 available horses dealt hands.

`fn_audit_fleet_health` now counts only horses that are not disabled. The
false alarm is gone.

## 2. `fleet_seat_starvation` measured the wrong thing, and undersold it

It compared raw open seats against a fixed 150, so its meaning drifts with the
size of the floor. Measured while writing this, the real state was far worse
than the number suggested:

    97 cash tables, 767 seats, 88 filled -- 11.5% occupancy

and the finding still read as a mild "156 open seats" warning.

It is now an occupancy ratio (>45% empty), the title states it plainly --
_"680 of 767 cash seats are empty (11.3% full)"_ -- and the evidence carries
the supply arithmetic including `available_horses`, so a reader can see
whether the constraint is seeding or simply too few enabled horses for too
many tables.

## 3. The overlays and empty freerolls are the same capacity fact

`HorseOverlayGuard` is working. It fills events -- _"Lunch Rush (NLH Deep):
3/34 entries ... registered 14 horse(s)"_ -- and runs out of candidates at the
margin, saying so every time: _"every candidate is outside its activity window
or at the four-table cap."_

The arithmetic behind that: 584 available horses, each awake 10-17 hours a day
(so roughly 56% at any instant, ~327), each capped at four tables, against 767
cash seats plus every tournament and freeroll running at once. The pool is not
being filtered too hard; there simply is not enough of it.

**This is Dan's decision, not an agent's**: enable more of the 416 disabled
horses, or run fewer cash tables. Both are business calls about scale and cost.
Nothing here changes either number.

## 4. A latent bug found on the way, fixed because it is invisible until it bites

`horseLoadMap` pages `table_seats` and `tournament_players` 1,000 rows at a
time ordered by `user_id` alone -- the least unique column in either read, since
a horse holds up to four seats and registers for several events at once.
LIMIT/OFFSET over an unstable order drops and repeats rows.

Both directions are documented failures of that very function: understated load
hands out a horse already at four tables (the trigger refuses it with 23514 and
the pass fills nobody -- the "added NONE" line above), overstated load holds a
free horse out of every board.

**Not currently firing**: 244 live seat rows and 540 registration rows, both
inside a single page. Fixed anyway, because it stays invisible until the fleet
outgrows a page and then presents as intermittent starvation with no error to
point at.

`PagedReadsAreDeterministic.law.test.ts` walks every paged read in both service
files and requires a deterministic order. It immediately found two more that
this changelog had not: a `hand_history` read (already correct -- it carries an
`id` tiebreaker) and the per-event entrant read, which ordered by `user_id`
inside a single tournament and so assumed one row per player -- an assumption
re-entry formats break. That one is fixed with the primary key as tiebreaker;
the comment directly beneath it warns that an incomplete entrant list lets a
double-registration through, which is exactly what a dropped row causes.

## Verification

`npx tsc --noEmit` clean. Full server suite: 308 files, 3428 tests, 0
failures. The migration asserts behaviourally that the idle finding no longer
counts a fleet of over 700.
