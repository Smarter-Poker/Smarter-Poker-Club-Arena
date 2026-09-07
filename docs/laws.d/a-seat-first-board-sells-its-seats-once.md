# tests/a-seat-first-board-sells-its-seats-once.law.test.ts

A spin, sng or two-max board counts EVERY entry against `max_players`, never
the survivors: `fn_enforce_tournament_capacity` excluded eliminated, winner,
left, withdrawn, cancelled, refunded and busted, so on a heads-up board a
bust-out put a sold seat back on sale and 35 events took between 3 and 32 paid
entries (the worst, 53e50799, holds 32 x 47.50 in its pool). Multi-table events
still count live entrants; the count is taken under the tournament row lock,
parent before child; `sng` is seat-first here exactly as it already is to
`fn_sync_seat_first_player_count`; and both registration doors ask one
definition of full, `fn_tournament_entry_cap_reached`, instead of reading
`current_players` - which is overwritten with the live SEATED count and cannot
answer the question.
