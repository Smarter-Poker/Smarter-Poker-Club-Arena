-- 20261017170945_the_crash_snapshot_read_finds_its_one_row_in_a_cached_plan.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- THE CRASH SNAPSHOT READ FINDS ITS ONE ROW IN A CACHED PLAN
-- ============================================================================
--
-- WHAT WENT WRONG (ClubArenaEngineKillStorm, 2026-10-17 12:57:31-58Z).
-- 74 engine kills on 42 tables in 27 seconds. The read every table makes on
-- start - getActiveHandSnapshotFull, "this table's unfinished hand, if any":
--
--     GET /hand_state_snapshots?table_id=eq.<id>&is_complete=eq.false
--         &order=updated_at.desc&limit=1
--
-- was cancelled on the 8 s service_role statement timeout 57 times (code
-- 57014). With the table id and `false` written into the SQL it takes 0.1 ms on
-- idx_hand_snapshots_one_active_per_table, the partial unique index
-- (table_id) WHERE is_complete = false. But PostgREST sends both as
-- PARAMETERS, and a cached generic plan cannot use a partial index whose
-- predicate is a parameter: it cannot prove `is_complete = $2` is `false`.
-- Measured with EXPLAIN (GENERIC_PLAN) on production:
--
--     Index Scan using idx_hand_state_snapshots_table_hand  (table_id, hand_number)
--       Index Cond: (table_id = $1)
--       Filter: (is_complete = $2)
--
-- That walks EVERY snapshot the table has ever kept to find the one that is
-- not complete: 4,783 to 10,523 rows (6.5 to 17 MB of hand JSON) on the
-- tables that timed out, scattered over a 6.3 GB heap. pg_stat_statements:
-- 423,937 calls, mean 0.99 ms, max 7,830 ms. Forty tables booting at once
-- did that walk together and blew the timeout. No lock wait was logged
-- (log_lock_waits is on, deadlock_timeout 1 s) and every pg_cron job in that
-- minute finished in milliseconds: it was this one plan, not the database.
--
-- THE FIX. An index the PARAMETERISED plan can use: (table_id, is_complete).
-- Both columns are now index conditions, so the generic plan reads only this
-- table's incomplete entries - at most one, by the unique index's own rule -
-- whatever plan the cache holds. The partial unique index stays: it is the
-- one-active-hand-per-table rule, not just a read path.
--
-- WRITE COST. A snapshot is inserted once per hand and flipped complete once
-- per hand; the per-action updates change state_json / updated_at, neither
-- of which is in any index, so they stay HOT exactly as before. The new index
-- adds one entry per hand and one update at completion. Repeated table_id
-- keys deduplicate, so it is far smaller than the heap.
--
-- LOCKS. hand_state_snapshots is written on every action of every live hand,
-- so a plain CREATE INDEX would block play for the length of a 4.3M-row scan.
-- STEP 1 builds CONCURRENTLY, outside any transaction (SHARE UPDATE EXCLUSIVE:
-- writers keep writing; it waits only for transactions already running). One
-- DDL statement, one schema-cache reload. STEP 2 is one short transaction that
-- refuses unless the index is built and VALID, the precedent of
-- 20260930232349. Apply outside the :50-:03 break window (CLAUDE.md
-- section 2 rule 8). No cron, watcher or reconciler.
-- ============================================================================

-- ============================================================================
-- STEP 1 - OUTSIDE ANY TRANSACTION
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hand_state_snapshots_table_complete
  ON public.hand_state_snapshots (table_id, is_complete);

-- ============================================================================
-- STEP 2 - ONE TRANSACTION
-- ============================================================================
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relname = 'idx_hand_state_snapshots_table_complete'
       AND i.indisvalid
       AND i.indisready
  ) THEN
    RAISE EXCEPTION 'STEP 1 index missing or INVALID: idx_hand_state_snapshots_table_complete. DROP INDEX CONCURRENTLY IF EXISTS it and re-run STEP 1.'
      USING ERRCODE = '55000';
  END IF;
END $$;

COMMENT ON INDEX public.idx_hand_state_snapshots_table_complete IS
  'Serves the engine boot read of a table''s unfinished hand (getActiveHandSnapshotFull) under PostgREST''s cached generic plan, which cannot use the partial idx_hand_snapshots_one_active_per_table because is_complete arrives as a parameter. 2026-10-17 12:57Z: that read walked 5-10k snapshot rows per table and timed out 57 times.';

COMMIT;
