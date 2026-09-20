-- ═══════════════════════════════════════════════════════════════════════════
--  AN APPEND-ONLY TABLE MUST VACUUM ON ITS INSERTS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260919220701 added idx_bbj_contrib_pool_created, a COVERING index whose
-- whole value is the INCLUDE: the flow CTE of fn_bbj_mini_for_club is a pure
-- aggregate over backup_portion, so an index-only scan finishes without
-- touching the heap at all. That migration argued the index-only scan would
-- actually happen because "bbj_contributions is append-only in practice
-- (324,497 inserts and ZERO updates or deletes in the window), so the
-- visibility map stays set".
--
-- THE VISIBILITY MAP IS NOT SET BY BEING APPEND-ONLY. It is set by VACUUM, and
-- nothing else. Measured immediately after the index was applied, 2026-09-20:
--
--     Index Only Scan using idx_bbj_contrib_pool_created
--       Heap Fetches: 112106          -- one per row returned
--       Buffers: shared hit=101151
--     Execution Time: 110.609 ms
--
-- Every row in the window cost a heap visit, because every page holding a
-- recent row was still unmarked. 24,310 of 37,464 pages were all-visible;
-- the missing 13,154 were exactly the recent ones this function reads.
--
-- WHY AUTOVACUUM HAD NOT RUN IN NINE DAYS. This table already carries an
-- aggressive tuning set, and every knob in it counts DEAD tuples:
--
--     autovacuum_vacuum_scale_factor=0.0, autovacuum_vacuum_threshold=2000
--     autovacuum_analyze_scale_factor=0.0, autovacuum_analyze_threshold=2000
--
-- On a table with zero updates and zero deletes, dead tuples barely exist, so
-- none of that ever fires. The only trigger that CAN fire is the insert one,
-- and it was left at the cluster defaults - threshold 1000 plus 0.2 x 1.57M
-- live rows = 315,800 inserts. At 33,078 inserts a day that is once every 9.5
-- days, which is precisely what pg_stat_user_tables showed:
--
--     last_autovacuum   2026-09-11 20:31:48+00     (9 days earlier)
--     n_ins_since_vacuum 251,834
--
-- So the covering index was decaying between vacuums and nobody would have
-- seen it: the plan still SAYS "Index Only Scan", it just pays for the heap.
--
-- AFTER a manual VACUUM (ANALYZE) on 2026-09-20, same query, same pool:
--
--     Heap Fetches: 254        (was 112,106)
--     Buffers: shared hit=745  (was 101,151)
--     Execution Time: 34.169 ms
--
-- and fn_bbj_mini_for_club itself, on the estate's busiest club (112,130 rows
-- in its seven-day window): 16 ms cold, against a 3,591.4 ms cumulative mean
-- over 7,801 calls and 28,017 seconds of database time.
--
-- This migration is what keeps that. It mirrors the flat-threshold style the
-- table already uses rather than inventing a second convention: scale factor
-- zero, one explicit number. 20,000 inserts is roughly every fifteen hours at
-- the current rate, and a vacuum of a table that is already 98.6% all-visible
-- only scans the pages that are not, so it costs almost nothing to run often.
--
-- This is not a sweep, a watcher or a reconciler. It is the one built-in
-- mechanism that maintains a visibility map, given the numbers that decide
-- when it runs.
--
-- This migration creates no function, table, view, index, trigger or policy,
-- so nothing can look it up: a storage parameter is invisible to every catalog
-- probe that check-migrations-are-live.mjs makes. It states its own proof.
--
-- @live-proof: (SELECT reloptions @> ARRAY['autovacuum_vacuum_insert_threshold=20000'] FROM pg_class WHERE oid = 'public.bbj_contributions'::regclass)
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE public.bbj_contributions SET (
  autovacuum_vacuum_insert_scale_factor = 0.0,
  autovacuum_vacuum_insert_threshold    = 20000
);

DO $$
DECLARE
  v_opts text[];
BEGIN
  SELECT reloptions INTO v_opts
    FROM pg_class WHERE oid = 'public.bbj_contributions'::regclass;

  IF NOT (v_opts @> ARRAY['autovacuum_vacuum_insert_threshold=20000']) THEN
    RAISE EXCEPTION
      'the insert threshold did not take: reloptions are %', v_opts;
  END IF;

  IF NOT (v_opts @> ARRAY['autovacuum_vacuum_insert_scale_factor=0']
       OR v_opts @> ARRAY['autovacuum_vacuum_insert_scale_factor=0.0']) THEN
    RAISE EXCEPTION
      'the insert scale factor did not take: reloptions are %', v_opts;
  END IF;

  /* The covering index this exists to protect. If it is ever dropped, this
     setting is pointless overhead and should go with it - say so here rather
     than leave a number nobody can explain. */
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='bbj_contributions'
       AND indexname='idx_bbj_contrib_pool_created'
  ) THEN
    RAISE EXCEPTION
      'idx_bbj_contrib_pool_created is gone; this insert-vacuum tuning existed only to keep its index-only scan index-only';
  END IF;
END $$;

COMMIT;
