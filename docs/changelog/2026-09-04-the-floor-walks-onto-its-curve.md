# The floor walks onto its curve, and the seeder stops arguing with it

**2026-09-04, continuing the same day's work.** The planner's first live order
was `human_yield`. This adds the second, `occupancy_wind_down`, and the half
without which it would have been worthless: the seeding cycle now carries the
same curve, so a seat freed here is not refilled thirty seconds later.

Dan asked whether a horse pulled off a table works normally next time. It does

- see below - but a pull on its own would have been undone within one seeding
  cycle, so both halves ship together.

## Does standing a horse up damage it? No

A stand goes through `engine.leaveTable()`, the same door a human's Leave Table
button opens: auto-fold if mid hand, `leave_pending`, and a cash-out at
settlement through `atomic_seat_cashout_locked`. The chips land back in the
club wallet and the horse returns to the available pool. `HorseSessionRotator`
has been doing exactly this every 90 seconds since 2026-07-24 as ordinary
session behaviour, and `seedAllTables` reseats from the pool on its next cycle.
Nothing is lost and nothing is marked.

## Why a pull alone would not have stuck

`HorseFleetManager.seedAllTables` fills each table toward `occupancyTargetFor`,
a PER-TABLE target with no knowledge of the per-host occupancy curve. Stand a
horse up and the seat is below that table's target, so the next 30-second cycle
fills it again. That is not a wind-down, it is a cash-out and a buy-in per
horse per cycle: expensive, and the loudest tell a floor can have.

So the seeding cycle now reads the curve too:

- **The cap is on BODIES, per host.** One horse holding four seats is one body.
  A horse already seated on the host may still open another table, so
  multi-tabling is untouched; only a NEW body is refused.
- **It can only ever refuse a seat.** Nothing in `HorseFleetManager` stands
  anybody up on account of it - a source test fails if `leaveTable` or
  `atomicCashout` ever appears in that file. The floor comes down through the
  paths that already exist and through the planner's wind-down.
- **Every failure path lands on NO CAP**, which is today's behaviour exactly:
  controller switched off, membership map unread, population reading zero, or
  a human short-handed at the table (bypassed outright). This is the same
  doctrine as the bankroll gate, and for the same reason: a gate that refuses
  on a value it could not read is what emptied the cash floor for forty
  minutes on 2026-08-31.
- **The body count updates as seats are taken**, not once per cycle. A cap read
  from the position the cycle STARTED with would let one pass seat the whole
  floor past it.

## The wind-down walks, it does not drop

Four stands per host per cycle. The room already sees up to four departures
every 90 seconds from ordinary session ends, so four per 30 seconds per host is
a few times the natural rhythm rather than a stampede, and the planner already
picks at most ONE victim per table - so no table loses more than one seat per
cycle whatever the ceiling is. A host 120 bodies above its curve reaches it in
about fifteen minutes.

Both stand orders now go through one `stand()` helper, so there is exactly one
call site for `leaveTable` and one freeze gate in front of it. The law pin in
`theFreezeIsTotal.law.test.ts` moved to that helper in this commit and now also
asserts there is only one such call site.

**The kill switch stops a wind-down and does not stop a yield.** `planFloor`
emits no occupancy order at all on a killed snapshot but still runs its yield
pass, so both rules are served by the snapshot and neither is re-decided in the
executor.

## And the reason none of this had ever worked

Running the planner against the live floor found something the tests could not:

```
Midway Union        80 open tables, 74 with players, 362 seats
Deep Stack Society 167 open tables, 128 with players, 350 seats
tables with status 'running'                                    0
```

Every live cash table on the platform reads `waiting`. `tables.status` is not a
statement about whether a game is being played: `HorseFleetManager` sets it to
`running` as a side effect once a second player sits, and the hourly
maintenance restart leaves the whole floor back at `waiting`. `shapedTables`
filtered on `status === 'running' || 'active'`, so for part of every hour the
entire shape half of the planner - buckets, seat orders, the joinable
guarantee, the occupancy wind-down - reasoned about an EMPTY list and reported
a floor of nothing, confidently.

Section 13 rule 3 of CLAUDE.md already says this about the other status string:
never gate a table on `tables.status`. Occupancy is a fact about SEATS. It
reads seats now, and the snapshot has already excluded closed and tournament
tables, so anything reaching the planner is a real, open, playable cash table
whether or not a hand happens to be in progress that second.

Human yield never depended on it - it loops every table on the host - so a
waiting player was always served while everything else was blind. Five tests
pin the corrected reading, including the exact 03:58 shape that exposed it.

## What this does to the floor when it deploys

Read live at 03:58 Chicago, inside the night window:

| Host               | population | live bodies | night cap | over | to the curve |
| ------------------ | ---------- | ----------- | --------- | ---- | ------------ |
| Midway Union       | 584        | 178         | 58        | 120  | ~15 min      |
| Deep Stack Society | 416        | 130         | 41        | 89   | ~12 min      |

The planner wants 115 wind-down stands and gets 8 a cycle. Overnight the room
will visibly quieten to roughly a third of its current head count, which is
what the 10% night curve asks for; by 20:00 the peak cap is 233 and 166 and the
seeder fills back up on its own. Nothing here touches the daytime floor.

**Still reported and still executed by nobody:** 89 close orders from the
exotic and limit caps, and every seat and open order. The close half is the
next decision - a floor held at 58 bodies across 74 open tables is the right
head count spread over far too many tables, and closing tables is what fixes
that rather than thinning them.

## Verified

Server typecheck clean, 5,096 tests across 357 files. Client typecheck clean,
12,568 tests. The live floor was read through the planner directly, never by
booting GameServer. Nothing was written to production.
