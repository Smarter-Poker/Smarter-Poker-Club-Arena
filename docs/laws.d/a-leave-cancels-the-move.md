# tests/a-leave-cancels-the-move.law.test.ts

A player who leaves a must-move game loses the move planned for them, the chair
it reserved and their place on the list: `fn_cash_game_roster_track` used to
keep a departed player on the roster while any move was pending, so a rejoin
inside that window kept the old list position and the old spent seat change,
and a swap partner was held for a side that never came. Also pins the two
smaller truths in the same migration: a seat change listed from a feeder that
was later renumbered Main 1 is cancelled with the allowance returned (the main
game has no seat change), a re-listed request follows the player to whatever
chair they are actually in while keeping the allowance spent, and no browser
role holds a write grant on `cash_seat_moves` or `cash_game_waitlist`.
