-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820002733 "leaderboard_covering_indexes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d5eaa58c718a91c3ea4a05474cc2b157 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Leaderboard read-path indexes.
--
-- Both boards read player_stats_snapshots for exactly three dates (period
-- baseline, previous-window end, previous-window start) and aggregate per user.
-- idx_pss_date covers only snapshot_date, so each of those probes still had to
-- visit the heap for every matching row to fetch the six measure columns -
-- 3,537 shared hits per call at 1,398 players, and that grows linearly with the
-- player base while the board is refetched on every filter change and on a 30s
-- poll per viewer.
--
-- A covering index turns those probes into index-only scans.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_pss_date_user_measures;
--   DROP INDEX IF EXISTS idx_pss_club_date_user_measures;

CREATE INDEX IF NOT EXISTS idx_pss_date_user_measures
  ON player_stats_snapshots (snapshot_date, user_id)
  INCLUDE (hands_dealt, sum_big_blind, total_winnings, total_losses, tournaments_won);

-- Club board additionally filters by club_id.
CREATE INDEX IF NOT EXISTS idx_pss_club_date_user_measures
  ON player_stats_snapshots (club_id, snapshot_date, user_id)
  INCLUDE (hands_dealt, sum_big_blind, total_winnings, total_losses, tournaments_won, total_rake);

ANALYZE player_stats_snapshots;
ANALYZE player_stats;
