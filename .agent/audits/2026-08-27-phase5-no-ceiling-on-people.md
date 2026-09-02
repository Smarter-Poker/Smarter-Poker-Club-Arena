# Phase-5 sweep — no ceiling on people, and a suite that stops crying wolf

Date: 2026-08-27 · Agent: cowork-mobile · Scope: **Club Arena only** (World Hub excluded by instruction)

## What Dan asked, and the correction I owe first

> "WHY IS THERE A 400 CAP? THERE SHOULD NEVER BE A CAP ON THE AMOUNT OF PLAYERS
> IN THE CLUB, UNION OR ANYWHERE ELSE."

**It was never a cap on players.** Nobody was stopped from joining a club, a
union, a table or a tournament by any of these. They were PAGE SIZES on
background reads - how many rows one maintenance pass looked at.

But the objection is right where it counts: a read that silently returns part
of the room caps what the code can SEE, and every one of these then treated its
slice as the whole room. And my first fix was itself wrong in the same spirit -
I raised 400 to 5000 and added an alarm, which only moves the day it breaks.
The ceilings are gone now, not raised.

## The four ceilings removed

| site                             | was                          | what a truncated read did                                                                                                                                                                                                                                                  |
| -------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HorseSessionRotator.rotate`     | `.limit(400)`, **unordered** | 348 live seats measured that day = **87% of it**. Past 400 Postgres returns an ARBITRARY 400: tables silently stop rotating, no error, no log. Unordered means the survivors also change between passes, so a table can be visible on one cycle and invisible on the next. |
| `horseLoadMap` seat half         | `.limit(20000)`              | Its own docstring says a truncated set understates load and hands a horse a fifth table, and that "Unknown is UNKNOWN". Nothing checked for a full page, so saturation would have passed as a complete answer.                                                             |
| `horseLoadMap` registration half | `.limit(20000)`              | same                                                                                                                                                                                                                                                                       |
| same-tournament entrant guard    | `.limit(20000)`              | A missing id is a horse that does not look registered - so it gets registered into the SAME tournament twice, the exact bug that block exists to prevent.                                                                                                                  |

All four now page until a short page ends them. The loop guards are
anti-runaway asserts that REPORT, not data caps. Every paged read is ordered,
because an unordered `.range()` can serve a row twice or skip it between pages -
the defect the `club_members` house rule was written for after ten horses
vanished from a cashier.

## The waitlist: humans could be starved behind horses

`seats.ts` fetched the **ten oldest** waitlist entries and looked for a human
among them. The queue is deliberately horse-seeded ("atmosphere"), so if the
ten oldest happened to all be horses it notified NOBODY while real people
waited directly behind them.

Measured before changing it: 12 tables with a queue, 22 waiting, no queue
longer than 10, and no table with a human stranded behind ten horses - so this
was **latent, not live**. Fixed anyway. It now walks the queue in pages until a
human turns up.

**Deliberately NOT the one-query version.** The obvious fix is an embedded
`profiles!inner(is_horse)` filter. `table_waitlist.user_id` carries **two**
foreign keys - to `profiles(id)` AND to `auth.users(id)` - so that embed is
ambiguous, and a 400 there returns null data, takes the early return, and
stops **every seat offer** silently. That would be a far worse regression than
the bug being fixed, and I could not verify PostgREST's resolution from SQL.
Two plain reads cannot fail that way.

## The test suite was crying wolf, and that is its own bug

Full server runs failed **2, then 4, then 5** specs across DIFFERENT files on
three consecutive runs - while every one of those files passed alone. Root
cause, measured:

- `HorseLeague.test.ts` - CPU-bound simulation, **8.5s of the 10s** default
  budget when run alone.
- `EngineStartResilience.test.ts` - **8.06s** of 10s, and `startable()` left
  three collaborators unstubbed (`restoreButtonFromHistory`,
  `restoreSitOutsFromSeats`, `evictExpiredSitOuts`) despite its own docstring
  promising "everything start() touches AFTER the opening read stubbed out".
  With `sleep` stubbed to a no-op, those DB reads set the pace of the wait
  loop. When the first spec timed out, its still-spinning loop leaked an extra
  `loadSeatedPlayers` call into the next spec, which asserts an exact call
  count - hence "expected 2, got 3".

**Attribution was proven, not assumed**: the same failures reproduce on a clean
checkout of main with my changes stashed. They are pre-existing, not audit
fallout.

Fixed by stubbing the three collaborators the file already promised to stub,
and giving those two CPU-bound describes an explicit 60s budget - stated
per-describe, never globally, so a genuine hang in the ~1,900 millisecond-fast
specs is still caught. A suite that reddens at random teaches everyone to
re-run until green, which is how a real failure gets waved through.

**Result: two consecutive full server runs, 1,941/1,941, zero failures.**

## Verified

- server: `tsc` clean · **1,941/1,941 twice in a row**
- client: `tsc` clean · **7,343/7,343**
- new pins mutation-tested (dropping the order + saturation check turns them red)

## Reported, not changed — the remaining 31 ceilings on people-tables

A sweep found 35 hard row limits on tables representing people
(`club_members`, `table_seats`, `tournament_players`, `profiles`, `agents`,
`friendships`, `union_clubs`, `table_waitlist`). Four are fixed above. The rest
split two ways and I did NOT touch them, because deleting a limit is not
automatically an improvement:

- **Genuine UI paging/previews** - search dropdowns at `limit(10)`/`limit(20)`,
  a 4-seat table preview, "online friends" pills. Correct as written.
- **Complete-set operations that deserve their own pass**: `StatsExport`
  (`club_members` 5000), `AgentAssignmentPanel` (2000), `AgentPromoPanel`
  (1000), `ClubDetailPage` member list (500), `TournamentResultsPage` (5000),
  `TournamentBrainContext` (5000), `HorseSelfTuner` (1000), admin
  `union_clubs` (100). Each silently drops rows past its ceiling in an
  operation whose whole point is "all of them" - a club with 5,001 members
  exports 5,000. They need the same paging treatment, and one of them
  (`StatsExport`) is an export a club owner would reasonably trust.

That is the next task, and it is a bigger, more careful one than it looks:
several of those feed UI that assumes a bounded array.

## Also still open (unchanged)

- `union_clubs`: 6,590,684 reads on a 2-row table (hot-path re-query).
- The 4 real reconciler criticals and the 166 stranded `chip_escrow_holds` -
  financial decisions, Dan's.
