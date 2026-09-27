-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821160016 "assert_index_wallet_tx_diamond_lookup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 232333223dbeab53517e05249dbf7a76 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  THE 8-SECOND LOBBY  (ledger entry for an index built CONCURRENTLY)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found 2026-08-21 by driving the club lobby in a real signed-in browser: the
-- page sat on its spinner long enough to trip its own stall watchdog ("club
-- home initial load exceeded 15s"). The slow requests were four copies of one
-- query, 1.8s to 4.1s each:
--
--   SELECT amount FROM wallet_transactions
--    WHERE user_id = $1 AND type = 'credit'
--      AND category IN ('diamond_purchase','diamond_reward','diamond_refund')
--
-- BEFORE:
--   Gather (actual time=7940..8015 rows=0)
--     Parallel Seq Scan on wallet_transactions (actual 7922..7922 rows=0)
--       Rows Removed by Filter: 1047653
--   Execution Time: 8015.602 ms
--
-- Eight seconds, 2.1M rows / 749MB scanned, to return ZERO rows. The table has
-- (user_id) and (user_id, created_at) indexes and the planner used neither:
-- with `type` and `category` unindexed it costed a filtered index scan above a
-- parallel seq scan and took the scan.
--
-- AFTER (partial index over exactly the predicate):
--   Index Only Scan using idx_wallet_tx_user_diamond (actual 0.007..0.007 rows=0)
--     Heap Fetches: 0
--   Execution Time: 0.035 ms
--
-- WHY THIS FILE ONLY ASSERTS. The index was created with CREATE INDEX
-- CONCURRENTLY, which cannot run inside a transaction block, and every
-- migration here is applied inside one. A plain CREATE INDEX would have taken
-- a SHARE lock and blocked INSERTs into the wallet ledger for the length of
-- the build -- several seconds of frozen writes while hands are being dealt.
-- So the DDL ran out of band and this entry records it and fails loudly if the
-- index is ever missing, which keeps the ledger honest without pretending the
-- statement is transaction-safe.
--
-- The exact DDL, for a rebuild or a fresh environment (run it OUTSIDE a
-- transaction):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_user_diamond
--     ON public.wallet_transactions (user_id)
--     INCLUDE (amount)
--     WHERE type = 'credit'
--       AND category IN ('diamond_purchase','diamond_reward','diamond_refund');
--
-- ROLLBACK: DROP INDEX CONCURRENTLY public.idx_wallet_tx_user_diamond;

DO $do$
DECLARE v_ok boolean; v_valid boolean;
BEGIN
  SELECT true, i.indisvalid
    INTO v_ok, v_valid
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('public.idx_wallet_tx_user_diamond');

  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION
      'ABORT: idx_wallet_tx_user_diamond is missing. Create it CONCURRENTLY (see the DDL in this file) before recording this migration.';
  END IF;

  -- A CONCURRENTLY build that fails leaves the index behind and INVALID, where
  -- it costs writes and serves no reads. That is worse than absent.
  IF NOT v_valid THEN
    RAISE EXCEPTION
      'ABORT: idx_wallet_tx_user_diamond exists but is INVALID (a failed CONCURRENTLY build). Drop it and rebuild.';
  END IF;
END $do$;

COMMENT ON INDEX public.idx_wallet_tx_user_diamond IS
  'Serves DiamondService diamond-balance lookups. Without it that query is a parallel seq scan of the whole ledger (8s) and it runs on every lobby load.';
