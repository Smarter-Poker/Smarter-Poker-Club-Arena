# The tournament break counts a held table as parked (2026-09-10)

## What was measured

Every tournament table came back from the hourly break about two and a half
minutes after the cash tables. After each break on 2026-09-10, cash tables
dealt again a median 18-61 s after :00; tournament tables took 136-176 s.

The engine log for the 12:55 break shows why:

    12:55:00  [GameServer] LAST HAND - Announcing final hand on 50 tournament(s)
    12:57:20  [GameServer] Last hand did not land on every table within 120s - starting the break anyway
    13:02:30  [GameServer] BREAK ENDED - Resuming 50 tournament(s)

The maintenance break had already done the work. It called the last hand at
:53 and held every one of 483 tables with no cards in the air by 12:55:02 (its
restart gate opened then). But the tournament drain only accepted
`isWaitingForHandForHand()`, which is true only for a table held by the
tournament's own pause with its loop on the gate. A table held by another
authority, or an engine that had already stopped, never answered true, so
every tournament's five minutes started at 12:57:20 instead of 12:55.

#4105 then removed the 120 s grace ("the old grace estimate is not authority to
start a break while an accepted hand is still active"). That fixed a real
concern, but with this predicate the same wait would have had no end, and
every tournament would have stayed on the break screen until a restart.

## What changed

- `TournamentManagerBase.areAllTablesParked()` asks whether each table has
  cards in the air, not who is holding it. A table counts as parked when its
  loop is on the pause gate for any authority, when its engine has stopped, or
  when the maintenance break is holding it with `handController === null`. That
  last test is the same proof the maintenance restart gate trusts to replace
  the whole process. A table with a live hand still holds the countdown, and a
  failed inspection is still not proof (#4105's pin is unchanged).
- `GameServer.waitForAllTablesParked()` names the events it is waiting on every
  15 s. It also has a liveness ceiling of a whole break (5 min after the last
  hand was called): past that, it starts the countdown and reports which events
  never parked. This is not a grace estimate. No real hand is still in the air
  a whole break after :55, and without a ceiling one wedged table holds every
  tournament on the platform.

Tests: `server/src/SynchronizedBreakDeadline.test.ts` (4 new) plus the
maintenance, break-clock and recovery suites, 189/189.
