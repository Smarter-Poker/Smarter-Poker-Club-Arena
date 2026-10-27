# Boot progress survives the zombie sweep

The October27 13:34Z alert named113kills; the full13:19–13:40 ledger contains115tournament zombies:56load-table,30hand-number,22crash-recovery,5time-bank and2waiting. Two Morning Free Buy events were affected. This establishes the phases interrupted, not the elapsed duration of each read.

GameServer.ts:7881 used only msSinceProgress(), whose clock begins at engine construction. Startup advances loopPhase/loopPhaseSinceMs through its read steps, but these successful transitions do not stamp the hand-progress clock. Admission and several bounded boot reads can together outlive180seconds. The next reaper then kills a recently entered step as though that step had hung for180seconds. Actual production predicate plus real engine clocks reproduces six failing cases before the change (two existing-recovery cases pass).

Change: the existing zombie decision uses the newer of hand progress and current phase entry only for startup phases. Ordinary gameplay retains the hand-progress clock and every pause/lease/ownership/fleet guard is preserved. No new timer, retry, repair loop, financial write or delay. A boot phase stuck beyond180seconds still qualifies. Unknown phases retain the ordinary path. Regression executes the production predicate with the real engine clocks; existing required server discovery includes the test.

This source repair does not establish that every recorded kill was spurious, solve database pressure, or complete independent lease/knockout repairs. Protected merge and actual certified engine delivery/live proof remain required.
