-- RESTORE THE MATVIEW INDEXES THE POSTGIS CASCADE TOOK (2026-09-09)
--
-- Two scheduled jobs have been failing on every run since 2026-09-08 17:37:
--
--   home-trending-refresh  (*/15)  46 failures / 2 successes in 12h
--   pnm-locations-refresh  (*/30)  23 failures / 1 success  in 12h
--
-- Both with: cannot refresh materialized view "..." concurrently
--            HINT: Create a unique index with no WHERE clause on one or more
--            columns of the materialized view.
--
-- THE INDEXES WERE NOT MISSING BY DESIGN - they were destroyed. `ca_ddl_events`
-- records, at 2026-09-08 17:37:30.638426+00, role postgres, application
-- Supavisor - an ad-hoc SQL session, with NO corresponding row in
-- supabase_migrations:
--
--     DROP EXTENSION IF EXISTS postgis CASCADE;
--     CREATE EXTENSION postgis SCHEMA extensions;
--
-- `commander_home_groups.location_geog` is a geography column, so CASCADE took
-- everything downstream: 723 functions, 2 matviews, 2 views, 1 table, 1 column,
-- 2 constraints and 6 indexes - among them
-- `idx_mv_home_groups_trending_group_id` and `mv_active_poker_locations_pk`.
-- The same transaction re-created both matviews and refreshed them
-- non-concurrently, but never re-created their indexes. Both have had
-- idx_count = 0 ever since, and CONCURRENTLY has been impossible.
--
-- Only ONE of the two broken jobs raised an incident, so pnm-locations-refresh
-- had been failing every 30 minutes with nothing watching it at all.
--
-- CONCURRENTLY is kept for both: mv_active_poker_locations (491 rows) is the
-- PNM state-index hot path and a plain refresh takes an AccessExclusiveLock
-- that blocks every reader for its duration.
--
-- Uniqueness is proved, not assumed (checked immediately before writing this):
--   mv_home_groups_trending   0 rows,   0 distinct group_id
--     (and group_id is commander_home_groups.id selected with no GROUP BY or
--      DISTINCT, so it is the source primary key, one row per group)
--   mv_active_poker_locations 491 rows, 491 distinct (source, entity_id), and
--     0 null entity_id - it is a UNION ALL of venues and home groups, so the
--     source discriminator is part of the key.
--
-- These are built non-concurrently deliberately: at 0 and 491 rows the
-- exclusive lock is momentary, and one transaction means ONE PostgREST schema
-- reload rather than two (CLAUDE.md production DDL policy, rule 1). Do not
-- convert these to CREATE INDEX CONCURRENTLY - that cannot run in a
-- transaction and would breach that rule for no benefit at this size.
--
-- ROLLBACK: DROP INDEX public.idx_mv_home_groups_trending_group_id,
--           public.mv_active_poker_locations_pk;
--           (the refresh jobs then fail again exactly as they do now)
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_home_groups_trending_group_id
  ON public.mv_home_groups_trending (group_id);

CREATE UNIQUE INDEX IF NOT EXISTS mv_active_poker_locations_pk
  ON public.mv_active_poker_locations (source, entity_id);

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                  AND indexname='idx_mv_home_groups_trending_group_id') THEN
    RAISE EXCEPTION 'the trending index was not created - REFRESH CONCURRENTLY will keep failing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                  AND indexname='mv_active_poker_locations_pk') THEN
    RAISE EXCEPTION 'the locations index was not created - REFRESH CONCURRENTLY will keep failing';
  END IF;
END $post$;

COMMIT;
