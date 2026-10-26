# A short table is filled at the big table's next hand boundary (2026-10-26)

Dan: "INSIDE THE DIAMOND ARENA, THE TABLE BALANCING IS NOT UPDATING AND
PROPERLY, TABLES NEED TO ALWAYS BE BALANCED 100% OF THE TIME NO MATTER WHAT."

## What was wrong

Read on production 2026-10-26 05:45-06:00 UTC: Sunday Funday Main Event at
8/3, Late PKO at 9/4, Night Owl at 8/5/2/1, Six-Card Closer at
7/6/6/6/6/6/5/5/4 with no seat move for 45 minutes, all while players busted
normally. Over the hour 05:00-06:00 the platform made 390 seat moves that
broke a table and only 30 that balanced one. Every one of those events
balanced at the :55 break, the one moment their tables were parked anyway.

The gap rebalance (STEP 2 of checkTableBalance) plans "move one from the big
table to the short one". The big table is mid-hand almost every time the plan
is made, so the move is deferred and the table fenced: it parks after its
hand and waits 15 seconds for a sweep to claim it. The claim needed a whole
new sweep from the shared scheduler (16 events consolidating at once, sweeps
averaging the full 5 second budget on a loaded event loop). It nearly never
arrived inside the 15 seconds, the fence expired, the table dealt on, and the
next plan fenced it again.

## The fix

The fenced table's own park edge now does the move, at once
(`TournamentManager.claimGapBalanceAtBoundary` / `balanceParkedGapSources`):
fresh board read, fresh plan, the moves whose source is the parked table made
through the same atomic move door (`executePlayerMoves`). Other sources the
plan names are fenced and moved at their own next boundary. A parked table
the fresh plan no longer needs is released at once. It never runs beside a
sweep: a sweep admitted meanwhile yields and is owed again, and an edge that
lands during a sweep is drained as that sweep settles. A frozen platform, a
tournament break, a pending retirement or an unknown move outcome leave the
work to the sweep and let the table deal.

Breaks (durable parks) are unchanged and still claimed by the sweep.

Pinned by `server/src/tournament/aShortTableIsFilledAtTheBigTablesNextBoundary.law.test.ts`.
