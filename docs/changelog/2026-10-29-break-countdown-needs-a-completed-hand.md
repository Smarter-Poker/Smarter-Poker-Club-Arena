# Break countdown requires the actual hand boundary

GameServer.waitForAllTablesParked returned true after five minutes even when a tournament still had a hand in play. That contradicted the owner's October 25 rule retained on current main: every hand in this tournament completes before its five-minute break starts. The older September 10 test asserted the premature countdown and is replaced with the current required behavior.

The time-based success is removed. Only the actual parked predicate begins a countdown; shutdown, a stopped manager or a superseding break returns false. Existing bounded-frequency wait diagnostics, hand custody, table recovery authority and independent per-tournament countdowns remain unchanged. This does not resolve an unknown hand by timing it out or claim to repair the current original-hand stalls.

Two regressions fail before: a hand finishing at 301 seconds was treated as parked at 300; shutdown during an unresolved hand was also reported as a successful drain. The final connected engine suite passes 64 tests; root and server TypeScript compilation pass. Protected delivery and live behavior remain pending.
