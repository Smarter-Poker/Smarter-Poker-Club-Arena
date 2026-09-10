# tests/a-table-with-one-player-is-still-the-balancers-problem.law.test.ts

Ordinary tournament balancing reads the live tables that hold players from the
database, never from the dealing-engine registry. A one-player table has no
dealing engine but remains balance work. An unreadable table list is unknown
and re-arms the coalesced balance redrive rather than being treated as balanced.
