# The last hand pays, and a launch is never cut in half (2026-10-03)

## Finishes held from :53

`finishTournament` deferred every terminal settlement on `isMaintenanceFrozen()`,
which goes up at the :53 announcement. The database freeze (`fn_platform_frozen`)
arms at :55, and :53-:55 is the window in which every table finishes the hand in
front of it. An event decided by that hand waited for the thaw (~:00:30, up to
~8 minutes) with its winner unpaid.

The announcement now opens a terminal-settlement-only window
(`setLastHandSettlementWindow`) that closes 30 s before :55
(`MaintenanceBreak.TERMINAL_SETTLEMENT_RESERVE_MS`). Every other freeze edge
(countdown, adoption, recovery hold, release boundary) closes it and the thaw
clears it. `isTerminalSettlementFrozen()` is read in one place: the
non-satellite finish gate. Satellites keep the full freeze because their
settlement can admit a seat into a running target. Events decided later still
re-arm their 5 s retry and settle on the first pass after the thaw. Sweeps,
entries, seat moves, rebuys and deals still read `isMaintenanceFrozen()`.

## Starts cut in half by :53

MTT 4735c72d began seating at 04:50:59, certified 194 seats (~0.63 s each), was
refused `platform_frozen` at 04:53:01 by the seat door
(`fn_entry_purchases_frozen` arms at the announcement), released its manager and
restarted from the half-seated board at 05:00:35.

The discovery start gate now estimates seating time
(`launchSeatingBudgetMs`: 20 s + 0.75 s a player) and holds a start whose
seating would cross the next :53 (`MaintenanceBreak.msUntilNextLastHand()`).
The first discovery pass after the thaw starts it, exactly as it already starts
an event whose clock falls inside the break. A replayed launch of a dealt game
(`finishingADealtGame`) is never held. No schedule = no hold.
