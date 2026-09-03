-- ============================================================================
-- Migration: index the two lookups the fee alarm now performs
-- Date:      2026-08-22 · Tier: 2 (additive indexes, no data change)
-- Applied to production 2026-08-22.
-- ============================================================================
--
-- `feeIsAccountedFor()` runs on the settlement FAILURE path — i.e. during an
-- outage, which is the worst possible moment for a slow query. Neither of its
-- fallback lookups had an index:
--
--   rake_records (table_id, global_hand_id)   only table_id existed, so every
--                                             check scanned one table's entire
--                                             rake history. This is the COMMON
--                                             path: 861 of the 1,020 open
--                                             alerts carried no hand_id,
--                                             because hand_id is null in
--                                             exactly the outage this fires in.
--   bbj_contributions (table_id, hand_number) no index at all — a sequential
--                                             scan over 219 MB.
--
-- The bbj index was built CONCURRENTLY. The rake_records one is plain: CREATE
-- INDEX CONCURRENTLY cannot run inside a transaction, and run outside one it
-- exceeded the MCP statement timeout and left an INVALID index behind, which
-- was dropped. It is a two-column btree; the write lock is brief.
--
-- ROLLBACK
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_bbj_contrib_table_hand_number;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_rake_records_table_global_hand;
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_bbj_contrib_table_hand_number
  ON public.bbj_contributions (table_id, hand_number);

CREATE INDEX IF NOT EXISTS idx_rake_records_table_global_hand
  ON public.rake_records (table_id, global_hand_id)
  WHERE global_hand_id IS NOT NULL;

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index
                  WHERE indexrelid = 'public.idx_rake_records_table_global_hand'::regclass
                    AND indisvalid AND indisready) THEN
    RAISE EXCEPTION 'idx_rake_records_table_global_hand is not valid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index
                  WHERE indexrelid = 'public.idx_bbj_contrib_table_hand_number'::regclass
                    AND indisvalid AND indisready) THEN
    RAISE EXCEPTION 'idx_bbj_contrib_table_hand_number is not valid';
  END IF;
END $assert$;
