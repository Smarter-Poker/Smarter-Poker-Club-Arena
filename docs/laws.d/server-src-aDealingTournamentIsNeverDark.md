# server/src/aDealingTournamentIsNeverDark.law.test.ts

A tournament's latest committed hand counts as activity in fn_ca_tournament_dark_candidates, alongside table writes and busts, so an event dealing between level changes is never read as dark and never has its manager rebuilt (Turbo Tuesday PKO bc8e3d86 was rebuilt ten times on 2026-10-21 while dealing, each rebuild stopping every table for ten to twenty minutes).
