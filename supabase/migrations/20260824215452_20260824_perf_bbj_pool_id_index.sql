-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260824215452 "20260824_perf_bbj_pool_id_index"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a46057890154310972e9e7a7b9c35975 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PERFORMANCE 2026-08-24 (additive only, no drops)
-- Evidence, pg_stat_statements window 2026-08-24 09:00 -> 21:35 UTC:
--   bbj_record_contribution: 1,811 calls, 2,607,898 shared_blks_read
--     = 1,440 blocks (11 MB) read PER CALL, mean 1,226 ms.
--   pg_stat_user_tables: bbj_contributions seq_scan = 3,244,
--     seq_tup_read = 506,841,592, n_live_tup = 1,654.
--   pg_class: relpages = 17,112 (134 MB) for 1,654 live rows.
--
-- Root cause: the ON CONFLICT fallback in bbj_record_contribution runs
--   SELECT * FROM bbj_contributions
--    WHERE pool_id = p_pool_id AND hand_id IS NOT DISTINCT FROM p_hand_id
-- `IS NOT DISTINCT FROM` is not indexable, and the only pool_id-leading index
-- (uq_bbj_contributions_pool_hand) is PARTIAL on `WHERE hand_id IS NOT NULL`,
-- so it cannot serve a NULL-tolerant probe. Planner falls back to a full
-- 134 MB heap scan on every call.
--
-- Fix: plain non-partial btree on pool_id. The equality predicate now drives an
-- index scan; hand_id is applied as a cheap recheck filter.

CREATE INDEX IF NOT EXISTS idx_bbj_contrib_pool_id
  ON public.bbj_contributions USING btree (pool_id);

-- hand_history INSERT is the single most expensive statement on the instance
-- (24,785 calls, mean 855 ms, 21,196 s total = 5.9 h of DB time in 12.6 h).
-- idx_hand_history_players_gin (177 MB) is a major contributor to that write
-- cost, but it is load-bearing: ca_player_hands() and ca_player_stats_full()
-- both probe it via `players @> ...`. Dropping it would turn player
-- hand-history lookups into 8.7 GB sequential scans.
-- Instead, enlarge the GIN fastupdate pending list so INSERTs append to a
-- buffered pending list rather than doing full index maintenance inline.
-- Default gin_pending_list_limit is 4 MB.
ALTER INDEX public.idx_hand_history_players_gin
  SET (fastupdate = on, gin_pending_list_limit = 32768);

