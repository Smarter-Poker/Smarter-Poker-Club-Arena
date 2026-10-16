# tests/the-weeks-tournament-clubs-are-read-from-an-index.law.test.ts

The week's tournament clubs are read from an index (2026-10-16): accounting_tournament_fee_sources carries a partial (coordinator_union_id, club_id) index so fn_accounting_week_clubs answers its DISTINCT club step with an index-only scan, because reading every union fee row from the 1.8 GB heap took 86.8 s cold on the first call of each job 272 tick.
