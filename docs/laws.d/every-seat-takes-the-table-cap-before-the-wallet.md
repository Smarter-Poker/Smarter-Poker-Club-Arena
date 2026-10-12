# tests/every-seat-takes-the-table-cap-before-the-wallet.law.test.ts

Every seat takes the table cap before the wallet, whatever its asset. Two
per-player locks guard a seat: the table-cap lock
(`hashtextextended('table_cap:' || user)`, the four-game limit) and the Daily
Missions lock, which locks the profile row. For a Diamond player the profile
row is the wallet. Every cash seat door, chip and Diamond, takes the table cap
first. `20260930123828` put it first for a Diamond tournament seat only. So one
player's chip registration (profile row, then the table cap in the roster
trigger) deadlocked with the same player's Diamond registration or Diamond cash
buy-in. The concurrency suite reproduced both against production's own doors,
with the chip registration paused as its roster row goes in.

`20260930131333` makes `fn_ca_lock_tournament_seat_acquisition` take the table
cap before the Daily Missions lock for every event. Before it the function
takes only the event's settlement lane and two shared locks, so for an entry
the table cap is the first per-player lock, as it is for every cash door. The
roster trigger's own acquisition is re-entrant. A chip entry charges, seats and
records exactly as before: the rolled-back rehearsal admitted a chip
registration identically before and after.

The law pins the asserted substitution (live md5, marker found once, reverse
proved), a new block with no asset condition that takes the cap before the Daily
Missions lock, the checks that the lock is the one the roster trigger and both
cash buy-ins take, the closing assertions and the live proof.
