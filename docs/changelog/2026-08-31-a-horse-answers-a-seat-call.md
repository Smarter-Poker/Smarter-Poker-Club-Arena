# A horse answers a seat call

**2026-08-31 — Phase 3 of the live cash games audit**

Dan, binding: _"MAKE HORSES ANSWER A SEAT CALL, PROGRAM THAT IN FULLY, THEY
SHOULD NEVER BE SKIPPED."_

## What was wrong

`fn_offer_open_seat` picked the head of the waitlist with

```sql
AND NOT COALESCE(p.is_horse, false)
```

which is exactly the pattern `CLAUDE.md` §10.5 forbids — an `is_horse` test that
excludes a horse from something a human gets. A horse could hold a place in line
forever and never be offered the seat.

It was not dead code. Measured before the change:

|                                                  |                      |
| ------------------------------------------------ | -------------------- |
| `table_waitlist` rows that are horses            | **10,004 of 10,055** |
| horse rows created in the last 24 hours          | **301**              |
| horse rows ever reaching `notified`              | **0**                |
| human offers that expired unclaimed, same window | 4                    |

Every horse row ends at `cleared`, never `notified` — while seats sat held for
60 seconds for humans who did not come back, with a queue full of players who
would have taken them skipped by construction.

## Why deleting the filter alone would have been worse

A horse has no client to click "sit down". Offering it a hold and nothing else
would idle the seat for the full 60 seconds while a real player waited — worse
than the bug.

This codebase already solved this exact shape once. From
`ServerTableEngineRunout`, 2026-08-18:

> "horses never answered `rit_offer`, so ANY horse in the all-in set let the
> offer expire and the hand always ran once — zero RIT hands in 24h of live
> traffic"

The answer there was `scheduleHorseRITResponses`: **make the horse respond,
never skip it.** Both halves ship together here.

## What changed

**The queue** — `20260831190110_the_seat_call_never_skips_a_horse.sql` removes
the exclusion. Whoever is first in line is offered the seat. The migration
carries a `DO` guard that raises if the filter is ever reintroduced.

Signature and grants were restated **from `pg_proc`, not from memory**, and that
caught two near-misses: `p_entry_ttl` defaults to **24 hours** live (a 2-hour
default would have quietly cut every waitlist entry's life by a factor of
twelve), and `authenticated` does **not** hold EXECUTE (granting it would have
opened a seat-offer RPC to the browser). `CREATE OR REPLACE` preserves neither
for you. The committed file is **md5-identical to what production ran**
(`19a8250c…`).

**The answer** — `HorseFleetManager.claimOfferedSeats` seats a horse holding a
`notified` row, through the same `atomic_table_buyin` path the seeding loop
uses. The cycle runs every 30 seconds against a 60-second hold, so a horse
always gets at least one look at an offer while it is still live. An expired
hold is deliberately left alone: that row belongs to `fn_offer_open_seat`'s own
sweep, and claiming it late would let a horse jump a queue it had already timed
out of.

It runs **before** the seeding loop. The hold only stops further _offers_ —
`fn_offer_open_seat` counts holds against `max_players` — it does not stop this
manager seeding a different horse into that very seat. Claiming first is what
makes the hold mean anything.

**One buy-in, two callers** — the seeding loop's inline sizing (profile →
5bb snap → table clamp → bankroll cap) is extracted to `computeHorseBuyIn` and
shared. A horse answering a call brings exactly what it would have brought to a
seat it was seeded into. Two copies of that arithmetic is the bug
`src/lib/cashBuyIn.ts` exists to end.

**The law test grew** — `horsesAreTreatedIdentically.test.ts` covered only the
bust/rebuy pause. It now also pins the seat call: the claim path exists and acts
on `notified`, it runs before seeding, an expired hold is left for the sweep,
both callers go through the one buy-in helper, and the migration carries its
guard.

## Verified

- A horse queued 5 minutes ahead of a human on a live table **was offered the
  seat** — `ok: true`, `is_horse: true` — inside a transaction that was rolled
  back, leaving zero probe rows.
- `tsc --noEmit` clean on `server/`.
- 9 tests in `horsesAreTreatedIdentically`, 5 of them new, all green.
- The engine change was **rebased onto `main`** rather than pushed from a stale
  copy: another agent had grown that file by 2.7 KB while this was in progress.
