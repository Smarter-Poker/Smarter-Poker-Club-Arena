# Fixed Board Audit: Chicago Time, Dark Satellites And A Board The Owner Screen Cannot Fight (2026-10-16)

Dan asked for every bug, gap, stub, error, regression and wiring issue in the
fixed-board work (#7071, #7074, #7093). Production was read first; what it
showed is below, with what was done about each.

## Found In Production

1. **The Midway Union's Sunday 200 Deep Stack did not exist for 2026-10-18,
   and its three satellites had been dark for three days.** Staff cancelled 108
   Midway events on 2026-10-13 between 16:07 and 16:17 UTC. Every one but the
   Sunday 200 Deep Stack had already started by today. The schedule had
   already spawned 2026-10-18 on 2026-10-11, so its spawn key was spent and
   nothing replaced it. `Sunday Deep Stack Satellite 5/10/25` resolve their
   target by name and found none, and a satellite waiting for its target is
   never paged by design, so all three stopped spawning on 2026-10-13 with no
   alert. (The Diamond Arena's Sunday 200 Deep Stack was never cancelled and
   its satellites ran throughout.)
   - Data: the spent key `4a367d72-...:2026-10-18:17:00` was renamed with a
     `:cancelled-by-staff-2026-10-13` suffix (kept, not deleted). The scheduler
     spawned the event again at 17:04 UTC (`b1011fa3`, 200 entry, 20,000
     guarantee, Sunday 12:00 PM Chicago) and eight Midway satellites were on
     the board one minute later, all targeting it.
   - Root: a satellite whose very next target was CANCELLED now pages inside
     the usual one-hour window, naming the cancelled event
     (`cancelledSatelliteTarget`). A target that simply has not been published
     yet still waits quietly, as before.

2. **The 8 PM Prime Time Free Buy still charged 2 chips tonight, Saturday and
   Sunday in the Midway Union**, and `TournamentRecurring.freeBuyAudit` had an
   open alert for it. #7093 left them because registered events are locked.
   All of their registrants were freerolled in and nobody can have rebought
   before the start, so lowering the rebuy and add-on to Dan's 1 chip takes
   nothing from anybody. Repriced through the engine role. The Diamond
   Arena's 40 freerolls at 1 Diamond were NOT changed: each carries a funded
   Diamond entry, and `fn_satellite_target_contract_is_immutable` refuses any
   change to a funded contract, correctly. The last of them starts Monday
   2026-10-19 06:00 Chicago; every arena freeroll published since #7093 is at 100.

3. **Every weekly event would have moved an hour on 2026-11-01.** The 25-event
   board is on Chicago wall clock, but the other 63 schedules in each club were
   UTC rows written for Chicago summer time. "100 Chip Guarantee Freeroll -
   6:00 PM" is 23:00 UTC; after the fall-back it would have started at 5:00 PM.
   Migration `20261016182049` rewrites all 126 to the same Chicago days and
   times they run at today, and writes each already-spawned occurrence's local
   key beside its UTC key so the change cannot spawn a duplicate. It aborts if
   any row's local pairs are not a clean days x times product, if any pre-start
   occurrence is left without its local key, or if a UTC row is left in either
   club.

## Found In The Code

4. **The engine wrote the board once per process.** A board row switched off or
   edited after boot stayed wrong until the next release. It is now written
   again every ten minutes (`FIXED_BOARD_RESYNC_MS`); a clean pass is one
   indexed read.

5. **The union owner's Recurring Schedules list offered Deactivate on board
   rows.** With the re-sync that button would have appeared to work and been
   undone within ten minutes. The database now refuses an authenticated or
   anonymous write to a board row
   (`fn_tournament_schedule_board_is_hard_coded`, engine and migrations
   unaffected), and the screen labels those rows "Fixed Daily Board" instead
   of offering the button.

## Checked And Correct

- Both clubs: 25 active board rows, 53 starts a day, every start in the next 24
  hours present, no board tournament created outside the schedule since the
  09:55 CDT release, no Midway or arena MTT created by the old timers.
- Every pre-start Midway freeroll is at 1 chip; every arena freeroll published
  after #7093 is at 100 Diamonds.
- The eight 2026-10-16 "could not be created" pages are resolved; no new one
  has fired.

## Proof

`server/src/services/theBoardIsAFixedSchedule.law.test.ts` (re-sync, board
config recognition, the database guard),
`server/src/services/aScheduledEventThatWillNotExistIsPaged.law.test.ts`
(a cancelled target pages).

## The Board Is Spread Out (Same Day, Second Request)

Dan: "REDO THEM SO TOURNAMENT DO NOT START AT THE SAME TIME, THAT THEY ARE
SPREAD OUT ACCORDINGLY THROUGHOUT THE DAY."

The first board started two events at the same minute 19 times a day, and the
clubs' own events landed on top of it at midnight, noon and 8 PM. It also ran
events at the wrong time of day for their names: the Early Bird Freeroll at
10:30 PM, Lunch Rush at 7:30 AM, the Prime Time Main Event at 1:30 PM.

- Every start in each club is now on a 20-minute grid (:00, :20, :40) with one
  event per slot: 53 board starts plus 17 slots held by the club's own events,
  70 starts a day, one to three in every hour, the two quietest slots at
  5:20 PM and 7:20 PM beside the Prime Time Free Buy.
- The five Free Buys keep their five hours. Every other board event runs in
  the part of the day its name says, its repeats at least an hour apart.
- The clubs' own events move off the board's slots: the 100 Guarantee
  Freerolls to 12:20 AM, 6:20 AM, 12:20 PM and 6:20 PM (renamed to match), the
  2:30 AM graveyard events to 2:40 AM, the 8 PM weekly event to 8:20 PM, the
  8 PM Sunday Deep Stack Satellite to 8:40 PM, and the Sunday 200 Deep Stack
  to 1:00 PM (the Midday Free Buy keeps noon).
- The clubs' own events move in a follow-up migration installed only once this
  engine is live: the engine that serves today does not read a time change,
  and installing the moved times ahead of it would have spawned both times for
  three days (the same data-ahead-of-code mistake behind this morning's eight
  alerts).
- No date is doubled by the move. A moved schedule carries its old times and
  the first date the new ones may take; any date that already has an
  occurrence at an old time keeps the old times, and only a date with nothing
  on the board yet takes the new ones (`resolveTimeChange`). An unreadable
  claim list waits a poll rather than guess.

Pinned in `theBoardIsAFixedSchedule.law.test.ts`: one event per slot across the
board and the reserved weekly slots, every start on the grid, one to three
starts every hour, the Free Buys on their hours, repeats an hour apart, and
the migration's slot list equal to the engine's.

## Installed

- `20261016182049` (Chicago time, engine-owned board rows): installed 18:20 UTC,
  before the engine, because the serving engine already reads a Chicago row.
- #7131 merged as `52ed250b`; client `cff3cf99` published; engine `52ed250b`
  serving after the 21:00 UTC break. The board rows were re-written by it
  within two polls and no date holds more board events than its day allows.
- `20261016210343` (the clubs' own events move off the board's slots):
  installed 21:03 UTC, after the engine that reads a time change was serving.
