# tests/a-table-with-one-player-is-still-the-balancers-problem.law.test.ts

`checkTableBalance` works on the tables that HOLD PLAYERS, read from the
database via `liveTournamentTableIdsWithPlayers()`, never on `tableEngines` -
which holds only tables that are dealing, so a table down to its last player
has no engine and was invisible to the balancer. An unreadable list is UNKNOWN
and re-arms the redrive; it never reads as balanced. Written after 35 running
events were found frozen with two or more funded players and no table holding
two of them, the worst being 36 players on 36 tables.
