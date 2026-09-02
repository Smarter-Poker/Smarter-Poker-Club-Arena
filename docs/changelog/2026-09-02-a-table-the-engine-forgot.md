# A table the engine forgot is a table nobody deals

2026-09-02. Three tournaments were frozen on production at the same moment,
eleven players' stacks with them, and every guard on the platform reported
healthy.

## What was measured, before anything was written

`/health` on the live engine lists one row per table it holds an engine for.
Comparing that list against `tables` gave the shape immediately.

| Tournament                          | Status     | Since         | Tables holding players                | In `/health`  |
| ----------------------------------- | ---------- | ------------- | ------------------------------------- | ------------- |
| `$100 Freeroll 6:00 AM` (3e8e2afa)  | RUNNING    | 12:42Z, 3h11m | table 10 (6 seats), table 22 (1 seat) | table 22 only |
| `$100 Freeroll 12:00 AM` (39f751e9) | RUNNING    | 08:08Z, 7h35m | table 7 (1 seat), table 24 (1 seat)   | table 24 only |
| `$100 Freeroll 6:00 PM` (f1b134c0)  | COMPLETING | 00:46Z, 15h   | two tables, 1 seat each               | neither       |

In all three, players sat on a table that is OPEN in the database and has no
dealer in the process. That state is invisible to every sweep, because every
sweep walks the engine map:

| Guard                            | Why it saw nothing                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `reviveDeadTableEngines`         | iterates `tableEngines` - no entry, no revive                                        |
| `checkTableBalance`              | iterates `tableEngines`, saw ONE table, so `size <= 1` returned before consolidating |
| `absorbOrphanedSeats`            | skips seats on OPEN tables, and `'waiting'` is open                                  |
| reopen-closed-tables             | only reopens `'closed'`                                                              |
| `stalledTableCount` in `/health` | counts engines, reported 0                                                           |

The 2026-08-15 sweep was written for exactly this failure -- its comment says
"the reaper deleted it from the map and NOTHING recreated it" -- and does not
cover it. Deleting the map entry is the one state a loop over that map cannot
see.

## The fix

`TournamentManagerBase.adoptEnginelessTables()`, called at the top of the
liveness sweep so the map is repaired BEFORE it is walked. It adopts a table of
this tournament that is open, not deleted, absent from the map, and still holds
a live seat -- at most four a pass on the existing 20-second cadence. Both
reads fail closed: an unreadable board adopts nothing. The map slot is written
before `start()` resolves, so the next pass cannot build a second dealer for
the same felt.

Nothing else changes. Once the table has its dealer back, the balancer sees two
tables instead of one and the existing consolidation merges them on its next
cycle, which is what should have happened three hours earlier.

## What this does NOT fix, and Dan should decide

`$100 Freeroll 6:00 PM` is COMPLETING with two players still holding chips
(1,781 and 122,593) on two tables. A COMPLETING tournament has no manager by
design, so this adoption never runs for it, and giving it dealers after a
payout path has begun would be worse than the freeze. It needs a decision about
the money, not a sweep: it went to COMPLETING with a heads-up match still
undecided, and `recoverStuckCompletingTournaments` has not resolved it in
fifteen hours.

## Pinned

`aStalledTournamentIsNoticed.law.test.ts` gains a case: the sweep adopts before
it walks, the scan is seat-gated, registration goes through
`registerTableEngine`, and both read failures report.
