# The floor planner gets its first live order, and the dashboard gets run

**2026-09-04.** Operation Stable Hand had a complete, tested decision layer and
nothing executing it. `planFloor` returned seat, stand, open and close orders
every time anybody asked, and nobody asked. This wires exactly ONE of those
orders to the floor, and in doing so runs the dashboard for the first time,
which found a defect worth more than the feature.

## What now executes: human yield, and nothing else

`StableHandExecutor` runs every 30 seconds and executes `stand` orders whose
reason is `human_yield`. Everything else `planFloor` decides is still reported
by `GET /stable-hand` and executed by nobody.

A yield is the safe first order to hand over because it is the only one that
can only ever REMOVE a horse from a seat a human is queuing for. It cannot
overshoot occupancy, it cannot open a table, it cannot spend a chip, and its
worst failure is a seat opening that did not have to. The seating loop it sits
beside is exercised every 30 seconds against real money and survived three
incidents to reach its shape; the 2026-08-31 outage emptied the cash floor for
forty minutes from a change smaller than this one.

**A horse is stood up through `engine.leaveTable(userId)`, the same door a
human's Leave Table button opens.** It auto-folds if the horse is mid hand,
flags the seat `leave_pending`, and cashes out at settlement through
`atomic_seat_cashout_locked`. The executor never touches `table_seats`, never
calls `atomicCashout`, and never deletes a seat row: deleting one skips the
refund and destroys the chips (CLAUDE.md 11.5 rule 3). A test reads the module
source and fails if any of those names appear in its code.

Three properties, each pinned:

- **The delay is measured from when the human joined the list**, not from when
  a 30-second cycle first noticed them. `table_waitlist.created_at` is now in
  the snapshot for exactly this. Measuring from first-sight would have quietly
  turned Dan's 2-5 minutes into 2 to 5-and-a-half.
- **A settling seat is not re-ordered.** `leaveTable` on a horse that is mid
  hand does not free the seat, so the same yield is planned again next cycle;
  a two-minute cooldown per (table, horse) stops a fresh auto_fold being
  queued every thirty seconds for the length of the hand. Keyed by SEAT, not
  by horse - a horse plays four tables at once.
- **The kill switch does not stop a yield.** `STABLE_HAND_KILL` stops new sits.
  A kill switch that strands a waiting human is not a safety feature, it is a
  second outage. `killed()` is never consulted in the executor.

`STABLE_HAND_CONTROLLER=false` turns the executor off and returns the whole
operation to planning only.

## Then the dashboard was executed for the first time, and reported n = 0

`GET /stable-hand` had been written, typechecked, shipped and never once run.
The first run returned HTTP 200 and a population of **zero for both hosts**,
against a fleet of 1,000 horses.

One line caused it:

```
supabase.from('club_members').select('user_id, profiles!inner(is_horse)')
```

PostgREST answers that with _"Could not embed because more than one
relationship was found for 'club_members' and 'profiles'"_, and the helper
returned 0 on any error. The identical embed against `table_seats` and
`table_waitlist` is unambiguous and works, which is precisely why nothing
looked broken: seats and waitlists read correctly, so the only wrong number on
the page was the one every cap divides by.

**Why that zero was dangerous rather than merely wrong.** `n` is the
denominator of `peakCap`, `nightCap` and the entire occupancy curve. At n = 0
every cap is 0, so a floor of 188 live horses read as 188 over the cap and the
plan asked for **170 stands**. Nothing executed them - the executor ships human
yield only, and no human was waiting - but that is the phased rollout catching
it, not the code being safe.

Fixed in three places, because one of them should have been enough and was not:

1. **The read.** `eligibleBodies` asks two unambiguous questions instead of one
   ambiguous one: page the memberships, then ask `profiles` which of those ids
   are horses. Every read is keyset-paged (`fetchAllRows`) and every id list is
   chunked (`selectInChunks`). The plain membership read returned **exactly
   1,000 rows** when this was written - PostgREST's silent ceiling, and one row
   short of it is indistinguishable from a complete answer.
2. **The snapshot.** `eligibleBodies` returns `null` on an incomplete read, and
   a host it could not measure is left OUT of the snapshot and named in
   `unreadableHosts`. A host that cannot be measured must not be managed.
3. **The planner.** `planFloor` refuses to seat, shape or wind down a host
   whose `n` is not positive, and says `host_population_unknown` instead. Human
   yield is deliberately still run: a yield does not depend on the population,
   and a waiting human is not made to wait for a failed read.

Verified against production after the fix: **n = 584 for Midway Union and 416
for Deep Stack Society** - to the body, the numbers the 2026-09-04
reconnaissance measured, and 584 + 416 = 1,000 exactly.

## What the honest dashboard now says, which Dan should see

Read at 03:30 Chicago, inside the night window:

| Host               | population | live now | night cap | full / one-open / joinable | target       |
| ------------------ | ---------- | -------- | --------- | -------------------------- | ------------ |
| Midway Union       | 584        | 187      | 58        | 22 / 7 / 4                 | 31 / 10 / 10 |
| Deep Stack Society | 416        | 138      | 41        | 16 / 12 / 39               | 54 / 18 / 18 |

The floor runs about three times the night cap the 10% curve asks for. That is
not a defect, it is the gap the controller exists to close, and closing it
means standing roughly 129 horses at Midway Union overnight. **Nothing in this
change does that** - occupancy is still reported only. It is the decision to
put to Dan before the next order is wired, because it visibly changes how busy
the room looks at 3am.

Also standing, and also only reported: 89 close orders from the exotic and
limit caps, 11 one-player tables listed as joinable at Deep Stack Society, and
four exotic tables running above $1/$2.

## Verified

Server typecheck clean, 5,075 tests across 357 files. Client typecheck clean,
12,568 tests. The dashboard was executed against production through the handler
directly rather than by booting GameServer, which would have double-run the
fleet manager, the recurring service and the executor against the live floor.
Nothing was written to production.
