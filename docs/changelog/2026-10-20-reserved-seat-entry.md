# Reserved Seats Lead To Game Admission

A spectator could tap a visibly empty chair in a must-move game and reach cash buy-in without asking the game's admission door. When another player's hold or move owned that capacity, buy-in displayed a reserved-seat error with no action.

Seat taps now call the existing fn_cash_game_join door before opening purchase confirmation. A confirmed assigned table is named and opened with buy-in requested. A confirmed queue place displays its position and opens the game lobby. Repeated taps share one in-flight request and replies from departed table/account scopes cannot navigate. Ordinary cash tables retain direct buy-in.

A definitive SEAT_RESERVED rejection clears the failed optimistic seat and replaces the purchase sheet with the appropriate queue. The ordinary table queue now has Join The List connected to the existing validated waitlist service, with duplicate-click protection and visible failure. No automatic purchase or wallet-rule change is introduced.

Regression coverage: cashSeatEntry.test.tsx, reservedSeatWaitlist.test.tsx, existing game admission receipts, waitlist routing, lobby lifecycle, and cash purchase recovery tests. Client-only behavior using existing APIs; no engine replacement required. Publication and live proof are recorded separately in the task checkpoint.
