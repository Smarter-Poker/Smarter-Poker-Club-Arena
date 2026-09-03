-- ═══════════════════════════════════════════════════════════════════════════════
-- Performance Indexes for Tournament Hot Queries
-- ═══════════════════════════════════════════════════════════════════════════════
-- These indexes target the most frequently executed query patterns identified
-- during the 31-audit sweep of tournament player count logic.
-- All CREATE INDEX IF NOT EXISTS — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. table_seats(table_id, left_at) — used in EVERY loadSeatedPlayers, syncStacksToDatabase,
--    syncTournamentPlayerChips, processLeavePendingPlayers, markHorseAsLeft recount,
--    late-reg seat lookup, and all authoritative current_players recounts.
CREATE INDEX IF NOT EXISTS idx_table_seats_active
ON table_seats (table_id)
WHERE left_at IS NULL;

-- 2. tournament_players(tournament_id, status) — used for active player counts,
--    position calculations in eliminatePlayerAuto, and HorseOrchestrator registration recounts.
CREATE INDEX IF NOT EXISTS idx_tournament_players_active
ON tournament_players (tournament_id, status)
WHERE status IN ('registered', 'playing');

-- 3. tables(tournament_id, status) — used for table discovery in checkTableMerge,
--    checkBalanceNeeded, late-reg table lookup, and TournamentEngine table queries.
CREATE INDEX IF NOT EXISTS idx_tables_tournament_active
ON tables (tournament_id)
WHERE status != 'closed';
