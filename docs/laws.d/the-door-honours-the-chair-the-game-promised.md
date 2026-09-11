# tests/the-door-honours-the-chair-the-game-promised.law.test.ts

The buy-in gate used to ignore the cluster planner's pending moves, so a
browser or the horse fleet could take a chair the tick had promised to a
must-move and the mover was refused `destination_full`. The gate now counts
pending, unlinked moves into the table - exactly the rows
`fn_cash_game_open_seats` counts, never a linked swap and never the player's
own - and refuses with the `SEAT_RESERVED:` prefix the client already
recovers from; the live gate is patched by anchor with every landmark of the
money path checked, and reads `is_horse` nowhere.
