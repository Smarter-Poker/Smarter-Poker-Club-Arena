# server/src/tournament/aFullFieldIsNotTheLastTable.law.test.ts

A Full Field Is Not The Last Table: on 2026-09-26 table 7441f3b1 (event
45b5b001) was retired as a stopped original under custody after its hand
permit went unresolved (`f06_operations` row 4c53987e, `park_requested`,
04:30:20). It held 9 players and the four other open 9-max tables had 6 free
seats, so the break could not be placed; the stopped-original path read that
as "the last table", asked `fn_f06_continue_no_start_last_table`, which SQL
refused because five tables were open, and threw "F06 original placement
remains pending" on every sweep. This pins, with the real TournamentManager,
retirement custody, F06 permit and TableBalancer, that such a source never
asks the last-table continuation, raises no error, keeps its break pending and
its table fenced under the same custody, asks the Manager's existing redrive,
and begins, moves all nine players and is acknowledged once seats free up;
and that the event's true last open table still takes the no-start
continuation.
