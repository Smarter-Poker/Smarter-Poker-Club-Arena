# A Dark Event Is Rebuilt Whatever Its Pause Timer Says

Date: 2026-10-12

## What Happened

Satellite 61961519 (Sunday Funday Six-Card Closer Satellite) dealt nothing from 23:52 to 05:00 UTC on 2026-10-11 with 9 players alive. The database paged it dark at 00:18 (fn_ca_tournament_dark_while_running, last activity 23:52:20). The engine sweep that exists for exactly this, GameServer.rebuildManagersOfDarkTournaments, never rebuilt its manager. The event recovered only when the 04:56 engine release rebuilt the manager, and it finished at 05:02.

The deadlock that froze it was fixed in PR #6696. This change fixes why the self-heal did not fire.

## Why The Self-Heal Stood Down

The sweep skipped any event whose every running table was "parked on purpose for no more than MAX_HEALTHY_PAUSE_MS" (ten minutes). For this event:

1. Table c01b0657's dealer had been stopped by break 444d8b63, whose close timed out. A stopped dealer was not counted at all, so it could not make the event look unhealthy.
2. Table 4af8f60c was parked by the satellite qualifier boundary (a terminal closeout fence). Past ten minutes the zombie reaper condemned it, the manager rebuilt its engine, the boundary parked the replacement again, and msPaused() started again from zero. engine_recovery_events records 25 of these zombie rebuilds between 00:10 and 04:50.
3. So "every running table parked for under ten minutes" was true almost every minute, and the rebuild almost never ran. The recovery the sweep trusted was resetting the timer the sweep read.

## The Fix

The dark clock is the database's: no hand, no bust and no table write for fifteen live minutes, maintenance breaks excluded. It did not reset across the 25 zombie rebuilds. Once that clock reads an event dark, the sweep no longer looks at parks, pause timers or stopped dealers. It stands down only for a deliberate authority asked by name, inside that authority's own bound (GameServer.darkEventHeldOnPurpose):

- The maintenance break, while MaintenanceBreak still holds the table.
- An operator floor hold, only when the floor read succeeded (ServerTableEngine.isHeldByOperatorFloor). A failed read is not an operator's decision.
- The add-on break, until its durable end plus the two-minute last-hand grace (TournamentManagerBase.deliberateDealingHold).
- An open final-table deal review, for at most its fifteen-minute pause plus the grace, and never once it is closing (TournamentManagerEliminations.deliberateDealingHold).

The scheduled tournament break keeps its own authority in the database read (on break for at most thirty minutes). Hand-for-hand deals hands, so a healthy one never goes fifteen minutes without one. The satellite qualifier boundary and every terminal closeout resolve in seconds; fifteen minutes of one is the wedge a rebuild cures.

The rebuild stays bounded: one per tournament per thirty minutes, and one critical page per window when an event is dark again after its rebuild.

## Pinned By

- server/src/aDarkEventIsRebuiltWhateverItsPauseTimerSays.law.test.ts reproduces the 61961519 sequence (stopped source dealer, boundary park the zombie reaper keeps resetting) and four hours of zombie cycles (eight rebuilds, never a loop), and pins each named authority and its bound.
- server/src/aDarkEventGetsItsManagerRebuilt.law.test.ts: "a healthy park is left alone" is replaced by "a dark event whose tables are parked is rebuilt".

## Why fn_f06_close_break Timed Out

At 23:52:13 the close's UPDATE of table c01b0657 fired fn_on_table_status_change, whose fn_refresh_club_activity_counts updates the club row. That row was held FOR NO KEY UPDATE by another tournament's finish in the same club (fn_complete_tournament_terminal_pre_seat_guard locks the club row for its whole transaction by design). That finish was itself stuck in lock waits and deadlocks with other finishes over vip_points_carry and union_wallets. The close waited about eight seconds and was cancelled by the statement timeout at 23:52:21. It was a hot club row behind a slow finish, not the maintenance break.

The close is restartable from its own record: fn_f06_close_break is keyed by break_id, returns the recorded state once close_confirmed, and a begun break is replayed by the manager's balance stage and by a rebuilt manager from durable state. PR #6696 removed the one path that kept the balance stage from replaying it, and this change makes sure a manager that still cannot replay it is rebuilt.

## Players

No chips, seats or prizes were moved by this change.
