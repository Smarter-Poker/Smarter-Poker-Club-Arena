# tests/tournament-players-stays-lean.law.test.ts

tournament_players keeps fillfactor 85 and vacuums after 2% plus 1,000 dead rows, and its six bloated plain indexes are rebuilt online and swapped in only when valid, identical and not backing a constraint, so the per-hand updates stay HOT and the table and its indexes stop accumulating dead space.
