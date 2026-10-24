# tests/a-classic-game-never-moves-its-players.law.test.ts

A Classic game never moves its players (Dan 2026-10-24: "PLAYERS SHOULD NOT BE MOVING ON CLASSIC GAMES PERIOD"): the cluster tick plans no must-move, breaks only an empty table and withdraws a break under seated players, the balancer plans nothing, a cash_seat_moves trigger refuses every move but the player's own seat change for a Classic game, and the lobby never promises a Classic player a move.
