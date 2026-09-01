-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825200154; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ca_hand_player_idx had NEVER been vacuumed. pg_stat_user_tables:
--   last_vacuum NULL, last_autovacuum NULL, last_autoanalyze NULL
-- on a table of 14,180,471 rows that the maintenance cron appends to 60,000
-- rows at a time.
--
-- WHY THAT IS EXPENSIVE RATHER THAN UNTIDY. The stats page's "lifetime hands"
-- is a count over this table, and it is written as an index-only scan on
-- purpose. An index-only scan is only index-only where the VISIBILITY MAP says
-- a page is all-visible, and nothing but VACUUM sets that bit. With the map
-- unset every tuple falls back to a heap fetch, so the plan reads the index AND
-- the table:
--
--   Index Only Scan ... Heap Fetches: 17308
--   Buffers: shared hit=10013 read=9233     Execution Time: 14,257 ms
--
-- 14.3 seconds, for a COUNT. That is most of the 15,071 ms the whole RPC was
-- measured at, and it is the half that the ca_hand_player_stat rollup does not
-- touch - the rollup replaced the 750 hand_history fetches, this replaces the
-- 17,308. Both were needed; fixing only one would have moved the page from
-- cancelled to still cancelled.
--
-- The settings are copied deliberately from hand_history, which already carries
-- them, because the two tables have the same shape of workload: large,
-- append-heavy, never updated. autovacuum_vacuum_insert_threshold is the one
-- that matters here - it is what makes autovacuum visit an INSERT-only table at
-- all, and it is what sets the visibility map. The scale factors are pinned to
-- 0 so the thresholds stay absolute rather than growing with the table, which
-- is the failure mode that let a 14m-row table go unvacuumed in the first place.
ALTER TABLE public.ca_hand_player_idx SET (
  autovacuum_enabled = true,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 5000,
  autovacuum_vacuum_insert_threshold = 20000,
  autovacuum_vacuum_insert_scale_factor = 0.0,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 2000
);

-- The rollup is pruned continuously, so it churns dead tuples rather than only
-- appending. It needs the same attention for the same reason: its read path is
-- an index range scan over (user_id, created_at DESC), and bloat there is read
-- directly as extra pages by every stats page load.
ALTER TABLE public.ca_hand_player_stat SET (
  autovacuum_enabled = true,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 20000,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 20000,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 2000
);
