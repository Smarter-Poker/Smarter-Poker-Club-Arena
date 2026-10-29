# Retained seat moves follow the current chair

A cash seat change from Madness Main 2 to the Feeder at 01:33:09 UTC on
October 29 was followed by a must-move back at 01:33:22 UTC. Both engine
`seat_moved` events remained replayable for 60 seconds. Remounting either
TablePage creates a new subscriber; replaying the older move could therefore
send the client back to the other table repeatedly, rebuilding the roster
and showing the loading cover each time.

The client now checks the authenticated player's active destination seat
before following a replayed move. An absent seat or failed read never becomes
a navigation instruction. A newer move, account/table scope change or unmount
invalidates an outstanding read. The latest follow callback is used without
restarting the check on every render. Live moves retain their immediate
navigation and moves received during identity hydration remain supported.

The engine's must-move rules and financial transactions are unchanged. This
is client delivery using existing authenticated seat reads, with no engine
activation or migration dependency. Existing client CI runs the regression
in `tests/unit/seatMoveNavigation.test.tsx`. It covers stale return moves,
valid recovery, failed/rejected reads, scope changes, newer events, duplicate
callbacks and React StrictMode. Before the repair seven new assertions failed;
after the repair the focused hook and tab suites pass.
