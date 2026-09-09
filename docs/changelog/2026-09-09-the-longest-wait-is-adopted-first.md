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

Measured 2026-09-09, either side of the 05:55 maintenance restart:

| time  | tournaments dealing (10m window) | RUNNING |
| ----- | -------------------------------- | ------- |
| 05:43 | 86                               | 140     |
| 06:04 | **8**                            | 126     |

and at the same moment, **13 RUNNING tournaments had dealt no hand for over an
hour**, with **183 players** still sitting `playing` in them. Those thirteen had
been through several hourly restarts and lost the race every time. The oldest,
`$100 Freeroll 6:00 AM`, had not dealt a hand in **903 minutes**.

The downstream shapes all follow from a tournament having no manager, and none
of them is a separate bug:

- no balance pass, so `$100 Freeroll 12:00 PM` held 41 open tables for 42 seated
  players, forty of them with exactly one player and therefore undealable;
- no seating sweep, so 29 players who had re-entered held 5,000 chips with no
  seat (`process_tournament_rebuy` credits chips seatlessly by design and the
  seating sweep is what places them);
- no elimination sweep, so pending knockout candidates climbed to 207.

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

It does not explain why the fleet cannot be adopted in one pass in the first
place - that is still open, and the changelog beside this one
(`2026-09-09-the-fleet-nobody-was-running.md`) carries the measurements and the
new `poker_tournament_fleet_unserved` gauge that makes the next occurrence
visible in ten minutes instead of fifteen hours.

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
