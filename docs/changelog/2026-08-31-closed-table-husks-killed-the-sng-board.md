# Closed-table husks killed the whole Sit-and-Go board for ten hours

**Date:** 2026-08-31
**Severity:** whole product surface dead (Sit-and-Go), silent
**Symptom:** zero SNG tournaments created since 2026-08-30 17:31 UTC, while
Spins ran healthily at ~150/hr.

## What was found in production

Thirty-two SNG tournaments sat `status='REGISTERING'` with `current_players`
0 (one had 1), fifteen to twenty-five hours past their `start_time`. All
thirty-two were heads-up (`min_players` = `max_players` = 2).

The differentiator was one column. **Every one of the thirty-two owned exactly
ONE table, and that table's `tables.status` was `'closed'`.** Healthy
REGISTERING Spins owned tables with `status='waiting'`.

Heads-up SNGs are not inherently broken: 12,508 have COMPLETED historically,
the last one starting 2026-08-30 17:30 - the minute this state formed.

## Why one closed table killed the board

1. A closed table cannot be seated into. `readSeatFirstPaidSeats` counts seats
   only on tables that are NOT closed, so every husk read as 0 paid seats.
2. The past-start top-up only fires on a board that has at least one paid seat
   (`paid > 0 && paid < seats`), so it could never fill them.
3. They therefore never started, and never left REGISTERING.
4. **And they permanently poisoned the spawner.** `ensureBoardOpen` treated a
   REGISTERING seat-first instance as covering its config when it _owned a
   table_ - existence, not joinability. All thirty-two configs read as covered,
   `missing.length` was 0 on every tick, and not one new SNG was ever opened.
   An absorbing state: the board could not recover on its own, ever.

## Who closed the tables

Not this repo. The close times cluster in bulk bursts (08:47, 09:06, 09:22,
10:53, 16:12, 17:27, 17:42, 18:40, 19:08 UTC) and stop dead after 19:08 - which
is when the retired World Hub legacy engine was disarmed.

The writer is `GameController._cleanupStaleTables`
(`Smarter-Poker-World-Hub/src/lib/poker-engine/GameController.js:2505-2521`):
every 60s it closed any lobby table whose LEGACY in-memory seat array was empty
and which was claimed more than `MAX_EMPTY_TABLE_AGE_MS` (10 min) ago. For a
Hetzner-owned table that array is empty by construction, so the test was not
"is it empty", it was "has it been ten minutes". It is already dead at source -
`this._staleCheckInterval = null` - and no husk has been created since.

Its RUNNING-tournament damage was repaired on 2026-08-30 by
`20260830191130_reopen_live_tournament_tables_closed_by_legacy_engine.sql`
(PR #1930 and the three follow-up repairs). Those migrations required the table
to still hold an open seat, so these thirty-two - REGISTERING, zero seats -
were outside every one of them and stayed dead.

## What ships here

Three changes, none of which depends on knowing what closed the table:

1. **The board can no longer be absorbed by a husk.**
   `ensureBoardOpen` now reads `status, is_deleted` alongside the id and counts
   an instance as covering its config only when it owns a table that is
   genuinely JOINABLE (`isJoinableTableRow`). A husk stops covering its price
   point, so the board opens a replacement on the next tick - whatever future
   bug creates the husk.

2. **A recovery sweep puts the felt back.**
   `GameServer.reopenTablesClosedUnderLiveTournaments()`, once a minute
   alongside `finishSeatFirstGamesThatAreOver`. For a REGISTERING or RUNNING
   tournament with no joinable table left, it reopens the newest closed
   non-deleted one (`waiting` for REGISTERING, `running` for RUNNING),
   resyncs `current_players` from the real seat rows, and hands a REGISTERING
   board a fresh 60-180s human window rather than dropping it straight into
   the past-start filler - the same rule `fn_repair_seat_first_games` uses.
   The planner (`services/liveTournamentTableRecovery.ts`) is pure and
   deliberately conservative: one table per tournament, never a deleted row,
   nothing for a tournament that has no table at all (creation owns that), and
   a RUNNING game is only put back when its field is still there
   (`MIN_SEATS_TO_REOPEN_RUNNING`) so a game that is already decided is left to
   the finish sweep.

3. **A sweep may not close a table under a live tournament.**
   `services/tableCloseGuard.ts` states the rule in one place: the
   tournament's OWN lifecycle (table break, finish, final-table deal, cancel)
   may always close its table; anything else is a sweep and may only close a
   table whose tournament is already COMPLETED or CANCELLED. An unreadable
   status counts as not-terminal. The orphan-table sweep in
   `cleanupStaleData` now re-reads the tournament statuses in the SAME pass as
   the write and filters the batch through it, closing the window between "this
   tournament looked finished" and "this table is now closed".

## Tests

`server/src/services/ClosedTableHuskCannotAbsorbTheBoard.test.ts`, 29 pins:
joinability, the ensureBoardOpen call site (including that the old
`withTable.has` set is gone), every branch of the reopen planner, and every
branch of the close guard including that it never blocks the tournament's own
lifecycle.

## No SQL was applied

None is needed. The reopen sweep heals the thirty-two husks on its first pass
after the engine deploys, through the ordinary engine path rather than a
one-off repair, and it keeps healing whatever comes next.
