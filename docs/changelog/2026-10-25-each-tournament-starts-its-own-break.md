# Each Tournament Starts Its Own Break

Owner ruling, October 25, 2026, 19:57 America/Chicago: "THE 5 MINUTE BREAK FOR
ALL TOURNAMENTS DOES NOT START FOR THE TOURNAMENT UNTIL ALL HANDS FOR THAT
SPECIFIC TOURNAMENT ARE COMPLETED, 'LAST HAND BEFORE BREAK' THEN BREAK, NOT
STARTING THE CLOCK BEFORE THE LAST HAND INSIDE THAT TOURNAMENT IS COMPLETED.
EVERY TOURNAMENT WILL START AND STOP THERE 5 MINUTE BREAK AT DIFFERENT TIMES
WITH THIS SETTING. BUT THIS IS 100% HOW ITS SUPPOSED TO BE."

## What was wrong

1. The table's break clock (TournamentBreakScreen, rendered by
   TableModalsLayer) was never handed `phase` or `breakEndsAtMs`. TablePage set
   both, but the layer passed only `timeRemaining`, so the screen fell back to
   its `counting_down` default and counted a local five minutes from :55 while
   the last hand was still in play. Dan's screenshot at 19:55:37 showed
   "Break: 4:24" over a live flop while the info bar said "Resumes: Last Hand".
2. The engine (GameServer.triggerSynchronizedBreak) waited for every table of
   every tournament, then stamped one shared end on all of them and resumed
   them all from one timer, so a tournament whose last hand was over still
   waited on another tournament's hand.

## What changed

- Client: TableModalsLayer passes the phase (defaulting to `last_hand`) and the
  server's end time, so the clock reads "Last Hand" until that tournament's
  countdown starts and then counts to the server's real end.
- Engine: at :55 every tournament is paused at once as before; then each one
  waits for its own tables (`waitForAllTablesParked([tm])`), starts its own
  five minutes, and is resumed by its own timer. The break window used to hold
  a newcomer stays open until the last tournament of the break has resumed.
  A maintenance break, when one is on, still fixes the end for every event.
- Pins: `tests/each-tournament-starts-its-own-break.law.test.ts`, and the
  behaviour cases in `server/src/SynchronizedBreakDeadline.test.ts`.
