# The Board Is A Fixed Schedule (2026-10-15)

Dan, verbatim: "TOURNAMENTS CAN NEVER FAIL, AND MUST ALWAYS RUN AND SPAWN,
INSTEAD OF RANDOMLY SPAWNING THEM, PUT THEM ON A HARD CODED SCHEDULE", then
"THESE SAME CORRECTIONS NEED TO BE MADE INSIDE OF THE DIAMOND ARENA AS WELL."

## What Happened

From 2026-10-13 08:15 Chicago (the 13:15 UTC engine kill storm) to about
2026-10-14 18:00 Chicago, the Midway Union's Free Buys, hourly lobby MTTs and
Spins stopped being created. Measured from `tournaments`: 2 of 5 Free Buys ran
on the 13th and 1 of 5 on the 14th, rolling lobby MTTs fell from about 47 a day
to 15 and 13, and Spins went to zero. The 113 weekly events in
`tournament_schedules` spawned 16 of 16 on both days.

## Root Cause

Two different creators. `tournament_schedules` rows are a fixed calendar:
`ScheduledTournamentService` claims one spawn key per occurrence, publishes 72
hours ahead and pages every occurrence it cannot create. The Free Buy board,
the lobby board (`HOURLY_SCHEDULE` plus the two-MTT floor) and the union board
(`XMTT_SCHEDULE`) were timers in `TournamentRecurringService`: they fire
relative to "now", keep one live instance per name, publish 30 minutes ahead,
and stand down on fleet and board holds. When those timers stopped, nothing
recorded that an event was owed, so nothing was missed in any table and nothing
paged.

## The Fix

- Migration `20261016042047_the_midway_board_and_the_diamond_arena_board_are_a_fixed_sch`
  adds 25 `tournament_schedules` rows per club, for the Midway Union and the
  Diamond Arena, at fixed `America/Chicago` times every day (daylight saving
  safe): the five Free Buys at 00:00, 08:00, 12:00, 16:00 and 20:00, and the 20
  lobby and union templates at the times they were already running. 53 starts a
  day per club.
- Each row's config names its template (`fixedBoard`). `fixedBoardRow`
  (`ScheduledTournamentService.ts`) builds the occurrence with the same
  builders the timers used: `fixedFreeBuyRow` wraps `freeBuyTournamentRow`, and
  `recurringMttRow` is the lobby/union MTT row. An unknown template is refused
  and paged, never guessed.
- `MIDWAY_BOARD_IS_ON_THE_FIXED_SCHEDULE` stands the three timers down for the
  Midway Union, so no second copy is published beside a fixed occurrence. The
  hourly Free Buy audit still checks every Free Buy.
- Diamond Arena occurrences go through the arena's priced door like its other
  63 schedules. `diamondSpawnConfig` now prices a fixed-board row from its own
  entry total, so a paid template is never read as a freeroll.
- The rows carry `type: 'fixed_board'`, a type the previous engine refuses, so
  no older binary can build one wrongly between the migration and the release.

## Proof

`server/src/services/theBoardIsAFixedSchedule.law.test.ts`
(`docs/laws.d/the-board-is-a-fixed-schedule.md`).

## Follow-Up: The Arena's 8 PM Free Buy (2026-10-16)

After release, 24 of the Diamond Arena's 25 fixed-board templates spawned. The
Prime Time Free Buy did not: it carries the Midway feature tier's 2-chip rebuy
and add-on, and the arena's creation door refuses any freeroll rebuy or add-on
that is not exactly one Diamond (`diamond_freeroll_rebuy_and_addon_cost_one_diamond`,
Dan's 2026-10-06 arena ruling). `diamondSpawnConfig` now prices an arena
freeroll's rebuy and add-on at one Diamond, so the arena runs all five Free
Buys a day. Pinned in `theBoardIsAFixedSchedule.law.test.ts`.
