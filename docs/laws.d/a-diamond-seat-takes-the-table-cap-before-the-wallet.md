# tests/a-diamond-seat-takes-the-table-cap-before-the-wallet.law.test.ts

Two writers of the same money take their locks in one order. For a Diamond
player the wallet is the profile row, and two locks guard a seat: the player's
table-cap lock (`hashtextextended('table_cap:' || user)`, the four-game limit)
and the wallet. The Diamond cash buy-in, cash-out and seat exits take the
table-cap lock first and the wallet after it. A Diamond registration took the
wallet first - `fn_ca_lock_tournament_seat_acquisition` calls
`fn_lock_daily_mission_user`, which locks the profile row - and the table-cap
lock last, in the roster trigger `fn_enforce_booking_game_cap`. A player whose
registration and cash buy-in raced each other deadlocked: the concurrency suite
measured it with five spenders released at once, and then deterministically,
with the registration paused inside its reserve while the buy-in arrived.

A Diamond seat acquisition now takes the table-cap lock before the Daily
Missions lock; the roster trigger's own acquisition is re-entrant and the order
is one. It left a chip event on the old order, and that made a new pair: one
player's chip registration and the same player's Diamond registration took the
two locks in opposite orders and deadlocked. `20260930131333` takes the table
cap first for every event
(`every-seat-takes-the-table-cap-before-the-wallet.md`); this law still pins
what `20260930123828`'s own file says.

The law pins the asserted substitution (live md5, marker found once, reverse
proved), the Diamond-only condition, the table-cap lock placed before the Daily
Missions lock, the check that it is the very lock the roster trigger and the
buy-in take, the final assertions and the live proof. Migration
`20260930123828`.
