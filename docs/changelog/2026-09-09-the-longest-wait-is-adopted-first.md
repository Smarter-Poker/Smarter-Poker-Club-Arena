# The longest wait is adopted first

2026-09-09

## The defect, in one line

The read that finds RUNNING tournaments needing a manager had no `ORDER BY`, so
whichever events sat at the end of the list sat there on **every** pass.

## Why an unordered list is worse than a random one

`discoverTournaments()` runs every five seconds and re-adopts every RUNNING
tournament this process has no manager for. Adoption is not cheap: a manager,
plus an engine per table, against a database where a single bounty-evidence read
was measured at 8,523 ms today. When the whole fleet cannot be adopted at once,
somebody is last.

PostgREST's unordered result is stable in practice. So "somebody is last" is not
a lottery that a given event eventually wins - it is the **same** event, on every
pass, through every hourly restart.

## What that looked like on production

Measured 2026-09-09, across the 05:55 maintenance restart:

| time      | tournaments dealing (10m window) | RUNNING | stalled >1h |
| --------- | -------------------------------- | ------- | ----------- |
| 05:43     | 86                               | 140     | 13          |
| 06:04     | 8                                | 126     | 13          |
| **06:12** | **170**                          | **196** | **13**      |

**Read all three rows before drawing anything from the middle one.** The first
draft of this page stopped at 06:04 and presented `86 -> 8` as the starvation
biting. It is not: it is the fleet being re-adopted after a restart, and eight
minutes later 170 of 196 were dealing again. That claim is withdrawn.

What survives the third sample is the last column. **Thirteen RUNNING
tournaments had dealt no hand for over an hour, and they were the same thirteen
before, during and after a full recovery of every other event on the platform.**
183 players were sitting `playing` in them. The oldest, `$100 Freeroll 6:00 AM`,
had not dealt a hand in **903 minutes**.

So those thirteen are not a slow tail. They are separately stuck, next to 170
healthy events, and this change is not what fixes them - see "What this does not
claim" below.

The shapes underneath them, all consistent with a tournament whose tables are
not being balanced:

- `$100 Freeroll 12:00 PM` held 41 open tables for 42 seated players, forty of
  them with exactly one player and therefore undealable;
- 29 players who had re-entered held 5,000 chips with no seat
  (`process_tournament_rebuy` credits chips seatlessly by design and the seating
  sweep is what places them);
- pending knockout candidates climbed to 207 platform-wide.

## The fix

```ts
.eq('status', 'RUNNING')
.order('started_at', { ascending: true, nullsFirst: false })
```

That is the whole change. It makes the order a queue instead of a lottery, and
it cannot make anything slower: the same set is adopted in the same number of
passes, and the event that has been waiting longest is simply no longer the one
that waits again.

`nullsFirst: false` because a row with no `started_at` is not evidence of a long
wait, and letting it sort to the front would hand the queue to exactly the rows
that prove nothing.

## What this does not claim

**It does not fix the thirteen.** They stayed stalled through a recovery that
took the rest of the platform from 8 dealing to 170, so whatever holds them is
not adoption order. This change is a correctness fix on its own terms - a stable
order IS a starvation order, and adoption cannot all happen in one pass - and it
should not be read as the answer to that incident.

Where that trail was left, so the next person does not restart it from zero.
Every one of the thirteen has open tables WITH live seats, roughly one player
per table, so no table can deal and only the balancer can rescue them. The
balancer builds its picture from `[...this.tableEngines.keys()]` - the tables
this manager holds an ENGINE for, not the tables the tournament has:

```ts
const balancerTables = await this.loadBalancerTables([...this.tableEngines.keys()], ...)
...
if (this.tableEngines.size > 1) { /* STEP 2: gap rebalance */ }
```

and `shouldBreakTable` returns false immediately when `allTables.length <= 1`.
So a manager holding engines for fewer than two of its tournament's tables can
neither break a table nor rebalance one, forever, while the tournament sits
there fully seated. That is consistent with every measurement taken, and the
next step is an engine log for those thirteen tournament ids - specifically
whether their table engines were ever adopted. It was not confirmed here, and it
is deliberately not asserted.

Two other things worth knowing at that point:

- `waitForHandComplete` returns `Boolean(engine && engine.isBetweenHands() &&
!engine.hasSettlementInFlight())`, so a MISSING engine reads as "still in a
  hand". STEP 1 guards that with its own `if (engine)`; the gap-rebalance path
  and the final-table path do not.
- `2026-09-09-the-fleet-nobody-was-running.md` carries the
  `poker_tournament_fleet_unserved` gauge, which makes the whole-fleet version of
  this visible in ten minutes instead of fifteen hours.

Worth recording for whoever picks that up: **cash-table adoption is bounded per
sweep (the C20 `engineStartBudget`, max 5, with a 40 ms stagger and a comment
explaining that it "spreads both the connection burst and the steady-state
cadence"), and tournament adoption is bounded by nothing at all** - even though
adopting a tournament is strictly the heavier operation. That asymmetry is now
pinned by a test so a change to either side has to be deliberate. Ordering was
fixed first because it is the part that is safe on its own: a budget could make
a slow recovery slower, whereas a queue cannot.

## Pinned

`server/src/theLongestWaitIsAdoptedFirst.test.ts` - five pins, windows bounded
by structure via `testHelpers/sourceWindow`:

- the window under test really is the RUNNING resume read;
- it orders by `started_at` ascending;
- a NULL start time sorts last, not first;
- the older fix beside it survives - an unreadable board is still UNKNOWN, never
  an empty one, because reading a failed query as "nothing is running" silently
  stops every re-adoption;
- the cash fleet still has its per-sweep budget, so the asymmetry above stays
  visible.

## Verification

- `npx tsc --noEmit` in `server/`: clean.
- `npx vitest run src/theLongestWaitIsAdoptedFirst.test.ts`: 5 passing.
- `src/engineStartBudget.test.ts` + `src/engineLiveness.test.ts`: 35 passing -
  the two suites nearest this code.
- `tests/unit/noFixedSizeSourceWindows.test.ts`: passing.
