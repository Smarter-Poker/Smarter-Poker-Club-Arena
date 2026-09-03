-- 20260822230941_autovacuum_tuning_hot_write_tables.sql
--
-- INCIDENT (2026-08-22, Dan): "None of the tables are active or loading in any
-- club. It says there are active games, but when you go to the lobby and then
-- go to tables, nothing happens, the games aren't running or active, you can't
-- sit down and nothing is playing."
--
-- This is a RECURRENCE of the saturation incident whose snapshot half was fixed
-- three hours earlier in 20260822233000_prune_snapshots_bounded_scan.sql. That
-- migration fixed ONE prune predicate. It did not fix the other prune, and it
-- did not fix the reason the damage accumulated, so the instance saturated
-- again the same evening.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROOT CAUSE
-- ─────────────────────────────────────────────────────────────────────────────
-- public.hand_history had NEVER been vacuumed or analyzed. Measured on
-- production before this migration:
--
--   pg_stat_user_tables: autovacuum_count = 0
--                        last_autovacuum  = NULL
--                        last_analyze     = NULL
--                        last_autoanalyze = NULL
--                        n_dead_tup       = 234,091
--   heap 8,955 MB / 1,146,286 pages, 1.1 GB across 8 indexes (one GIN).
--
-- Three consequences, all measured:
--
-- 1. THE VISIBILITY MAP WAS ENTIRELY UNSET, so every Index Only Scan
--    degenerated into random heap fetches:
--       Index Only Scan idx_hand_history_table_handnum
--       rows=5,563  Heap Fetches: 1,921  Buffers: hit=123 read=1,870
--       Execution Time: 36,964 ms
--    1,993 buffers is ~16 MB. Taking 37 s to read it is ~20 ms per 8 KB page —
--    the disk was completely saturated.
--
-- 2. THAT EXACT SCAN IS ON THE HAND-INSERT PATH. hand_history carries three
--    per-row AFTER INSERT triggers, and trg_hand_history_club_member_stats runs
--    a correlated NOT EXISTS over hand_history FOR EACH SEATED PLAYER:
--       NOT EXISTS (SELECT 1 FROM hand_history h2
--                    WHERE h2.table_id = NEW.table_id
--                      AND h2.hand_number > st.last_hand_number
--                      AND h2.hand_number < NEW.hand_number)
--    So one hand insert cost a mean of 913 ms over 32,274 calls — 8.2 CPU-hours,
--    the single largest consumer in pg_stat_statements.
--
-- 3. EVERYTHING ELSE STARVED. The club lobby's table list took 3,737 ms while
--    reading ONLY cached pages (Buffers: shared hit=57, read=0). A query that
--    touches no disk and still takes 3.7 s is not a bad plan — it is a backend
--    that cannot get CPU or I/O. Supabase Realtime's wal2json decode averaged
--    285 ms over 61,855 calls and fell behind, so the client received no live
--    table state.
--
-- Net effect for the player: the lobby rendered (its counts come from a cheap
-- rollup), but opening a table timed out and no realtime state ever arrived.
-- "It says there are active games, but nothing loads and nothing is playing."
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY AUTOVACUUM NEVER CAUGHT UP  (the actual regression)
-- ─────────────────────────────────────────────────────────────────────────────
-- Two pg_cron prune jobs delete from these tables continuously — 117 every 5
-- minutes, 119 every 2 minutes — while single runs took 38-155 s. They had no
-- overlap guard, so copies stacked. Worse, a run that exceeded the 2 min role
-- statement_timeout was cancelled and ROLLED BACK: it classified nothing, yet
-- still left up to p_batch dead tuples behind. Confirmed on production —
-- 400,000 sampled rows had has_human set on ZERO of them.
--
-- So the prune manufactured garbage forever and reclaimed nothing, while a
-- default-throttled autovacuum (vacuum_cost_limit 200, 3 workers) could never
-- finish a 10 GB table. Each run left the table more bloated and the next run
-- slower — a death spiral that ended with the instance pinned.
--
-- The prune was added WITHOUT the matching autovacuum tuning. That omission is
-- the regression this migration closes.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THIS MIGRATION
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-table autovacuum storage parameters only. No schema change, no data
-- change, no behavior change, and fully reversible via ALTER TABLE ... RESET.
-- The companion migration 20260823010000_prune_jobs_overlap_guard_and_self_bound
-- fixes the jobs themselves.
--
-- MEASURED AFTER APPLYING (same production instance, same queries):
--   hand_history first-ever autovacuum completed 2026-08-22 23:27:12 UTC
--   n_dead_tup              234,091  ->  535
--   trigger subquery         36,964 ms ->  934 ms   (Heap Fetches 1,921 -> 76)
--   club lobby table list     3,737 ms ->  0.415 ms
--   hand_history INSERT         913 ms ->  32.7 ms  (delta over 54 fresh calls)
--   sp_prune_hand_history    38-155 s, rolling back -> 3 s, 1,000 rows committed
--   hand throughput          25-71 hands/min -> 90-100 hands/min

-- hand_history: the engine's hottest write path.
--   scale_factor 0 + threshold 2000 => vacuum after 2,000 dead tuples instead of
--     after 20% of the table, a point this table never reached.
--   cost_delay 0 + cost_limit 10000 => let the worker actually FINISH. Under the
--     default throttle a 10 GB table takes longer to vacuum than it takes to
--     re-dirty, which is why autovacuum_count sat at 0 forever.
--   analyze thresholds keep planner statistics fresh; the planner previously had
--     NONE for this table and estimated 180 rows where 5,563 were returned.
ALTER TABLE public.hand_history SET (
  autovacuum_enabled              = true,
  autovacuum_vacuum_scale_factor  = 0.0,
  autovacuum_vacuum_threshold     = 2000,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold    = 2000,
  autovacuum_vacuum_cost_delay    = 0,
  autovacuum_vacuum_cost_limit    = 10000
);

-- hand_state_snapshots: 6.3 GB, pruned on a schedule, identical failure mode.
ALTER TABLE public.hand_state_snapshots SET (
  autovacuum_enabled              = true,
  autovacuum_vacuum_scale_factor  = 0.0,
  autovacuum_vacuum_threshold     = 5000,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold    = 5000,
  autovacuum_vacuum_cost_delay    = 0,
  autovacuum_vacuum_cost_limit    = 10000
);

-- tables and table_seats are small, but they are read on every lobby paint and
-- written on every seat change. Stale statistics here are what turn a lobby
-- into a "Still Loading" screen, so keep them fresh too.
ALTER TABLE public.table_seats SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay    = 0
);

ALTER TABLE public.tables SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay    = 0
);

-- Post-apply assertion: every table above must carry reloptions now. Without
-- this the migration could silently no-op and the spiral would resume.
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t, ', ')
    INTO v_missing
    FROM unnest(ARRAY[
           'public.hand_history',
           'public.hand_state_snapshots',
           'public.table_seats',
           'public.tables'
         ]) AS t
   WHERE (SELECT reloptions FROM pg_class WHERE oid = t::regclass) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'autovacuum reloptions were not applied to: %', v_missing;
  END IF;
END $$;

-- ROLLBACK
--   ALTER TABLE public.hand_history RESET (
--     autovacuum_enabled, autovacuum_vacuum_scale_factor,
--     autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor,
--     autovacuum_analyze_threshold, autovacuum_vacuum_cost_delay,
--     autovacuum_vacuum_cost_limit);
--   ALTER TABLE public.hand_state_snapshots RESET (
--     autovacuum_enabled, autovacuum_vacuum_scale_factor,
--     autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor,
--     autovacuum_analyze_threshold, autovacuum_vacuum_cost_delay,
--     autovacuum_vacuum_cost_limit);
--   ALTER TABLE public.table_seats RESET (
--     autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor,
--     autovacuum_vacuum_cost_delay);
--   ALTER TABLE public.tables RESET (
--     autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor,
--     autovacuum_vacuum_cost_delay);
--
-- Do NOT roll this back without first confirming hand_history is being
-- autovacuumed by some other means. Reverting restores the exact configuration
-- that took the platform down on 2026-08-22.
