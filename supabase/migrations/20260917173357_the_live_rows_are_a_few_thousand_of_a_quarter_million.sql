-- 20260917173357_the_live_rows_are_a_few_thousand_of_a_quarter_million.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE LIVE ROWS ARE A FEW THOUSAND OF A QUARTER MILLION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS (2026-09-17, performance checklist audit, phase 1)
--
-- Three engine sweeps ask the database for the live subset of tables that are
-- almost entirely history, and the only index the planner could use walked the
-- history to find the live rows. Measured on production with
-- EXPLAIN (ANALYZE, BUFFERS) before this migration:
--
--   tournament_players, status IN ('registered','playing') ORDER BY id
--     6,086 live rows of 617,429. Index Scan on the primary key, 130,470 rows
--     removed by filter, 132,465 buffers, 319 ms. pg_stat_statements: four
--     PostgREST shapes of this query, 25,340 calls, 177k to 324k buffers per
--     call (1.4 to 2.6 GB of shared buffers touched per call).
--
--   tables, tournament_id IS NOT NULL AND status <> 'closed' ORDER BY id
--     1,130 live rows of 254,070. Parallel Seq Scan with three workers,
--     63,286 rows removed per worker, 17,811 buffers, 119 ms, 4,369 calls.
--
--   cron_execution_log, status = 'running' AND started_at < cutoff
--     The workers' stale-run sweeper, 1,107 calls at 7,823 buffers and 177 ms
--     each, for a handful of rows. The existing (job_name, started_at DESC)
--     index cannot serve a status-only predicate.
--
-- Each index below is PARTIAL on exactly the live predicate the query carries,
-- so it holds the few thousand live rows and nothing else, costs the money
-- path nothing measurable on write, and lets ORDER BY id LIMIT n read n rows.
--
-- The fourth statement drops one of two identical unique partial indexes on
-- clubs(is_platform) WHERE is_platform. idx_clubs_one_platform was created by
-- 20260908034530 and ca_clubs_one_platform_club by 20260908114501; the later
-- one carries the COMMENT recording ruling 16, so it is the one that stays.
-- The uniqueness guarantee (one platform club) is unchanged: the surviving
-- index is UNIQUE on the same expression and predicate.
--
-- CONCURRENTLY, and therefore no BEGIN/COMMIT: tables and tournament_players
-- are written by every dealt hand and every seat change, and a plain CREATE
-- INDEX would hold a SHARE lock on each while it built. CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block, so this file follows the
-- 58 earlier migrations of the same shape (for example 20260912121000) and is
-- applied with psql, then recorded in supabase_migrations.schema_migrations
-- under this version and name.
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS <name> for each of the three
-- created below; the dropped duplicate can be recreated with the statement in
-- 20260908034530 if ever wanted, though nothing reads it (idx_scan = 0).

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_players_live_by_id
  ON public.tournament_players (id)
  WHERE status IN ('registered', 'playing');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tables_live_tournament_by_id
  ON public.tables (id)
  WHERE tournament_id IS NOT NULL AND status <> 'closed';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cron_execution_log_running_started
  ON public.cron_execution_log (started_at)
  WHERE status = 'running';

DROP INDEX CONCURRENTLY IF EXISTS public.idx_clubs_one_platform;
