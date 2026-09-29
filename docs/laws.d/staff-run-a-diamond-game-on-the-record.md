# tests/staff-run-a-diamond-game-on-the-record.law.test.ts

Phase 10, line 4 of the Diamond programme asks for staff-only game
configuration. Before this law, nobody could edit or close a Diamond cash
table, cancel a Diamond event or remove a player from one through a door a
signed-in person can reach, staff included. The chip doors for those acts all
authorize through a club role, and the Diamond Arena has no club operators. A
heads-up Diamond sit-and-go could be created but never sat, because nothing
opened its table. None of the five Diamond configuration doors recorded who
used it.

Platform staff now have five new doors of their own, each asking
fn_is_platform_admin() and a live session:

- fn_poker_diamond_edit_cash_table changes an empty table's name, stakes,
  buy-ins and seats. The result is held to the open door's rules and the
  creation guard's, and re-proved plain as written.
- fn_poker_diamond_close_cash_table closes a table, refused while any seat
  holds custody or a player sits.
- fn_poker_diamond_remove_tournament_player goes through the one withdrawal
  authority, whose Diamond branch sends the entry home from its own custody
  row.
- fn_poker_diamond_cancel_tournament goes onto the existing Diamond
  cancellation, which returns every entry and writes a receipt naming the
  operator.
- fn_poker_diamond_create_seat_first_board opens a Spin or a heads-up
  sit-and-go through the Diamond creation door, with its one joinable table in
  the same transaction.

Every Diamond configuration door, the five that existed and the five new ones,
files one admin_audit_log row through fn_log_admin_action. The row names the
operator and holds the state before and after. The open door also writes its
operator to tables.created_by.

The club-role gate, fn_can_create_games, is asserted unchanged. Widening it
would hand Diamond games to club roles and undo Phase 2. The shared creation
door changes only by asserted substitution, and so does the one chip function
that changes, the managed lifecycle guard. That guard now admits a
cancellation after registration for one event only: the one the staff
cancellation door names, in that door's own transaction. No switch opens and
nothing is priced.
