# tests/a-session-cannot-outlive-its-seat.law.test.ts

cash_player_session is derived from the seat and must not outlive it. Table
teardown closed seats and left 40 sessions open (657 opened vs 497 closed in
six hours); those leftovers then collided when a seat move re-pointed a live
session onto a destination already holding one, violating
cash_player_session_one_open and killing the post-hand leave_pending step.
Pins the trigger on tables that closes every session scoped to a table on its
transition into closed or deleted (as 'table_closed', deliberately not through
the leave path so nobody who was closed on is barred), the scope-led partial
index that trigger uses, the guard that closes a leftover as superseded before
every re-point - both swap re-points included and counted - and that each
migration refuses to finish unless it can prove the invariant holds.
