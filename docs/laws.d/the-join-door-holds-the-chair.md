# tests/the-join-door-holds-the-chair.law.test.ts

`fn_cash_game_join` used to answer 'seat' with a table it did not hold, so two
players told about the same last chair both got it and the second was refused
at the buy-in door. The door now writes the same 60 s `table_waitlist` hold the
open-seat offer writes (which the buy-in gate, the open-seat count and the
census already honour), locks each candidate table on the buy-in gate's own
key first so two callers in the same instant are serialized, returns and
refreshes an existing hold instead of writing a second one, keeps one live hold
per player per game, and reads `is_horse` nowhere.
