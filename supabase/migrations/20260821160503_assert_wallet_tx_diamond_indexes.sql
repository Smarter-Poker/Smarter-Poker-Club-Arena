-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821160503 "assert_wallet_tx_diamond_indexes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 17b0f3901a4c0295be945fdb6e18f4ac of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  DIAMOND LOOKUPS OVER A 2.1M ROW LEDGER  (ledger entry, built CONCURRENTLY)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Three queries in DiamondService read wallet_transactions filtered by
-- `category`, which was not indexed. wallet_transactions holds 2.1M rows /
-- 749MB and one player alone has 1.3M of them, essentially all chip movement;
-- his diamond rows number three. So every one of these read the whole ledger
-- to find almost nothing. Measured on production 2026-08-21:
--
--   1. lifetime EARNED   (user_id, type='credit', category IN 3 diamond kinds)
--        before: Parallel Seq Scan, Rows Removed by Filter 1047653 ->  8015 ms
--        after : Index Only Scan, Heap Fetches 0             ->     0.035 ms
--
--   2. lifetime SPENT    (user_id, type='debit',  category IN 3 spend kinds)
--        before: same shape, same full scan
--        after : Index Only Scan, Heap Fetches 0             ->     5.96 ms
--
--   3. transaction HISTORY (user_id, category IN 6, ORDER BY created_at DESC)
--        before: Index Scan on (user_id, created_at),
--                Rows Removed by Filter 1332504              -> 40316 ms
--        after : Index Scan on the partial index             ->     1.70 ms
--
-- The 40-second one is the diamond wallet history. The 8-second one runs on
-- every club lobby load, four times, which is what pushed the lobby past its
-- own 15s stall watchdog ("club home initial load exceeded 15s").
--
-- All three are PARTIAL indexes: only diamond-category rows qualify, so they
-- cost a few pages rather than indexing the whole ledger.
--
-- WHY THIS FILE ONLY ASSERTS. These were built with CREATE INDEX CONCURRENTLY,
-- which cannot run inside a transaction block, and migrations here are applied
-- inside one. A plain CREATE INDEX takes a SHARE lock and would block INSERTs
-- into the wallet ledger for the whole build -- seconds of frozen writes while
-- hands are being dealt. The DDL therefore ran out of band; this records it and
-- fails loudly if an index is missing or was left INVALID by a failed build.
--
-- DDL for a rebuild or a fresh environment (run OUTSIDE a transaction):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_user_diamond
--     ON public.wallet_transactions (user_id) INCLUDE (amount)
--     WHERE type='credit' AND category IN ('diamond_purchase','diamond_reward','diamond_refund');
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_user_diamond_spend
--     ON public.wallet_transactions (user_id) INCLUDE (amount)
--     WHERE type='debit' AND category IN ('diamond_deduction','vip_purchase','mint');
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_user_diamond_history
--     ON public.wallet_transactions (user_id, created_at DESC)
--     WHERE category IN ('diamond_purchase','diamond_deduction','vip_purchase','mint','diamond_reward','diamond_refund');
--
-- ROLLBACK: DROP INDEX CONCURRENTLY <name>;  (one per index above)

DO $do$
DECLARE
  v_name text;
  v_oid  oid;
  v_valid boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'idx_wallet_tx_user_diamond',
    'idx_wallet_tx_user_diamond_spend',
    'idx_wallet_tx_user_diamond_history'
  ] LOOP
    v_oid := to_regclass('public.' || v_name);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION
        'ABORT: % is missing. Create it CONCURRENTLY (DDL is in this file) before recording this migration.', v_name;
    END IF;

    -- A CONCURRENTLY build that fails leaves the index behind and INVALID,
    -- where it slows every write and serves no read. Worse than absent.
    SELECT i.indisvalid INTO v_valid FROM pg_index i WHERE i.indexrelid = v_oid;
    IF NOT v_valid THEN
      RAISE EXCEPTION
        'ABORT: % exists but is INVALID (failed CONCURRENTLY build). Drop and rebuild it.', v_name;
    END IF;
  END LOOP;
END $do$;

COMMENT ON INDEX public.idx_wallet_tx_user_diamond IS
  'DiamondService lifetime-earned. Without it: parallel seq scan of the 2.1M row ledger, 8s, on every lobby load.';
COMMENT ON INDEX public.idx_wallet_tx_user_diamond_spend IS
  'DiamondService lifetime-spent. Same full-scan shape as the earned lookup without it.';
COMMENT ON INDEX public.idx_wallet_tx_user_diamond_history IS
  'DiamondService transaction history. Without it: 40s, discarding 1.33M rows to return 3.';
