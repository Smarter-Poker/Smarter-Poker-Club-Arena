-- 20260827_index_two_hot_unindexed_fks.sql
--
-- Two foreign keys on non-empty tables had no covering index. Found by the
-- performance advisor cross-checked against pg_stat_user_tables on 2026-08-27:
-- of 12 unindexed FKs on public tables, TEN were on empty (0-row) tables where
-- an index is pure write overhead and was deliberately skipped. Only these two
-- carry real rows.
--
-- APPLIED VIA CONCURRENTLY, OUTSIDE A MIGRATION TRANSACTION, because
-- bbj_contributions is 241 MB / 703K rows and written on every live bad-beat
-- hand - a plain CREATE INDEX would hold a write lock for the whole build.
-- CONCURRENTLY takes no such lock. This file is the audit record; the index
-- was created directly via the Supabase MCP (apply_migration wraps statements
-- in a transaction, which CONCURRENTLY cannot run inside).
--
-- idx_bbj_contributions_player_id : APPLIED + VERIFIED VALID 2026-08-27
--   (4776 kB, indisvalid=true, on a table showing 59 seq_scans before this).
-- idx_tournament_rake_settlements_club_id : PREPARED, not yet applied
--   (a session classifier blocked the second CONCURRENTLY call; the statement
--    is safe to run as-is - 31K rows / 6 MB, a money table that only grows).
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS <name>;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bbj_contributions_player_id
  ON public.bbj_contributions (player_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_rake_settlements_club_id
  ON public.tournament_rake_settlements (club_id);
