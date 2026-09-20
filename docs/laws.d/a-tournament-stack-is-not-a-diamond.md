# tests/a-tournament-stack-is-not-a-diamond.law.test.ts

Three Diamond seat guards branched on `clubs.asset='diamonds'` and nothing
else, so every Diamond seat carried one equation: `table_seats.stack =
poker_diamond_custody.balance`. For cash that equation IS the product. For a
tournament it is a category error, and it made "a playing stack cannot reach a
wallet" true only BY ACCIDENT - a Diamond seat simply was its custody. This
pins the replacement that migration
`the_diamond_seat_guards_know_a_tournament_seat` put in its place: a tournament
seat is admitted by a funded live entry and by no equation with its stack; the
entry binds to the tournament and never to a seat, so nothing that looks up
"the custody for this seat" can find a playing stack; the entry holds exactly
the sum of the Diamond movements recorded for it, so a balance that play
produced has no movement behind it and aborts at commit; and the entry is fixed
to the player and the event it paid for. The cash equation is asserted
unchanged at all three guards, every new refusal carries its own message and
its own SQLSTATE (P0810-P0815, none of them the cash guards' 23514), and the
migration opens neither arena switch and writes no custody row.
