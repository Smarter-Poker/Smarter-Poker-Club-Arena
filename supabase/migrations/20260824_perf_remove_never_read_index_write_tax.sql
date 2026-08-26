-- PERFORMANCE 2026-08-24. Remove write tax from never-read indexes.
--
-- APPLIED TO PRODUCTION via Supabase MCP apply_migration 2026-08-24,
-- assertions green. Recorded in supabase_migrations.schema_migrations as
-- 20260824_perf_remove_never_read_index_write_tax.
-- Tier 2.
--
-- Companion to 20260824_drop_unused_indexes_on_hot_write_tables.sql (same
-- technique, disjoint targets - that one covers hand_state_snapshots,
-- commander_member_daily_stats, tournament_players and member_fee_rollup;
-- this one covers bbj_contributions and rake_records).
--
-- ============================================================================
-- WHY
-- ============================================================================
-- Every index must be maintained on every INSERT, UPDATE and DELETE of its
-- table, whether or not anything ever reads it. Measured against
-- pg_stat_statements over 2026-08-24 09:00 -> 21:35 UTC, this database
-- executed 47.40 core-hours of query time in a 12.58-hour window against
-- 2 vCPU (25.17 core-hours of capacity) - 188% oversubscribed. On a platform
-- in that state, an unread index is a pure tax on the hot path.
--
-- Both tables here are written once per raked hand:
--   bbj_contributions     656,688 rows
--   rake_records        1,259,553 rows
--
-- ============================================================================
-- SAFETY OF THE "NEVER READ" CLAIM
-- ============================================================================
-- pg_stat_user_indexes counters are cumulative since project creation
-- (2026-01-06) - pg_stat_database.stats_reset is NULL for this database.
-- These are therefore SEVEN MONTHS of observed zero reads, not a short window.
-- (pg_stat_statements WAS reset 2026-08-24 09:00, but that is a separate
-- counter and does not affect index scan counts.)
--
-- None of these back a constraint, a primary key, or a unique requirement.
--
-- idx_scan values recorded immediately before this migration:
--
--   idx_bbj_contrib_club_created      25 MB   idx_scan = 0
--   idx_bbj_contrib_created_at        16 MB   idx_scan = 10
--   idx_bbj_contrib_player            8 kB    idx_scan = 0
--   idx_bbj_contrib_club_player       8 kB    idx_scan = 0
--   idx_rake_records_table_created    53 MB   idx_scan = 0
--   idx_rake_records_club_id          13 MB   idx_scan = 1
--   idx_bbj_contrib_pool_id           (created earlier today, superseded)
--
-- The two non-zero ones:
--   idx_bbj_contrib_created_at - 10 reads in seven months against 656,688
--     rows of insert traffic is not a trade worth making.
--   idx_rake_records_club_id - 1 read in seven months, and strictly redundant
--     with idx_rake_records_club_created (club_id, created_at), which shares
--     the same leading column and was used 293 times.
--
-- idx_bbj_contrib_pool_id was created by this same audit earlier today as a
-- first attempt at fixing bbj_record_contribution. EXPLAIN ANALYZE proved it
-- useless: only 4 pools exist, so pool_id alone selects ~164k rows and the
-- planner correctly ignored it. It was superseded by the partial index
-- idx_bbj_contrib_pool_nullhand in
-- 20260824_perf_bbj_record_contribution_indexable_lookups.sql. Dropping it
-- here so a failed experiment does not become permanent write cost.
--
-- ============================================================================
-- RESULT
-- ============================================================================
--   bbj_contributions   9 indexes / 135 MB  ->  5 indexes / 100 MB
--   rake_records       11 indexes / 388 MB  ->  9 indexes / 322 MB
--
-- ============================================================================
-- ROLLBACK (all plain btrees; recreate CONCURRENTLY to avoid locking writes)
-- ============================================================================
--   CREATE INDEX CONCURRENTLY idx_bbj_contrib_club_created
--     ON public.bbj_contributions (club_id, created_at);
--   CREATE INDEX CONCURRENTLY idx_bbj_contrib_created_at
--     ON public.bbj_contributions (created_at);
--   CREATE INDEX CONCURRENTLY idx_bbj_contrib_player
--     ON public.bbj_contributions (player_id) WHERE player_id IS NOT NULL;
--   CREATE INDEX CONCURRENTLY idx_bbj_contrib_club_player
--     ON public.bbj_contributions (club_id, player_id) WHERE player_id IS NOT NULL;
--   CREATE INDEX CONCURRENTLY idx_rake_records_table_created
--     ON public.rake_records (table_id, created_at) WHERE player_contributions IS NOT NULL;
--   CREATE INDEX CONCURRENTLY idx_rake_records_club_id
--     ON public.rake_records (club_id);
--   CREATE INDEX CONCURRENTLY idx_bbj_contrib_pool_id
--     ON public.bbj_contributions (pool_id);
-- ============================================================================

DROP INDEX IF EXISTS public.idx_bbj_contrib_club_created;
DROP INDEX IF EXISTS public.idx_bbj_contrib_created_at;
DROP INDEX IF EXISTS public.idx_bbj_contrib_player;
DROP INDEX IF EXISTS public.idx_bbj_contrib_club_player;
DROP INDEX IF EXISTS public.idx_rake_records_table_created;
DROP INDEX IF EXISTS public.idx_rake_records_club_id;
DROP INDEX IF EXISTS public.idx_bbj_contrib_pool_id;

-- ============================================================================
-- POST-APPLY ASSERTIONS
-- ============================================================================
DO $$
DECLARE v_left bigint; v_names text;
BEGIN
  -- 1. All seven are gone.
  SELECT count(*), coalesce(string_agg(relname, ', '), '') INTO v_left, v_names
    FROM pg_class
   WHERE relname IN ('idx_bbj_contrib_club_created','idx_bbj_contrib_created_at',
                     'idx_bbj_contrib_player','idx_bbj_contrib_club_player',
                     'idx_rake_records_table_created','idx_rake_records_club_id',
                     'idx_bbj_contrib_pool_id');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'indexes survived the drop: %', v_names;
  END IF;

  -- 2. The index the bbj hot path now depends on must still exist.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_bbj_contrib_pool_nullhand') THEN
    RAISE EXCEPTION 'idx_bbj_contrib_pool_nullhand is missing - bbj_record_contribution would seq scan';
  END IF;

  -- 3. Constraint-backing indexes must be untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_bbj_contributions_pool_hand') THEN
    RAISE EXCEPTION 'uq_bbj_contributions_pool_hand was lost - bbj idempotency broken';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_rake_records_hand_id') THEN
    RAISE EXCEPTION 'uq_rake_records_hand_id was lost - rake idempotency broken';
  END IF;

  -- 4. The surviving read path for club-scoped rake reporting must remain.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_rake_records_club_created') THEN
    RAISE EXCEPTION 'idx_rake_records_club_created is missing - club rake reports would seq scan 1.26M rows';
  END IF;
END $$;
