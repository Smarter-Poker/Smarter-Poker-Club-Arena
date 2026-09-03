-- 20260823070000_autovacuum_union_wallet_transactions.sql
--
-- union_wallet_transactions is written on every raked hand
-- (atomic_distribute_rake) and read by fn_club_money_panel, which sums a whole
-- week of it on every load. It is the same shape as hand_history was: constant
-- inserts, a stale visibility map, and therefore index-only scans that fall
-- back to heap fetches.
--
-- Measured before this migration, after adding a covering index:
--   Parallel Index Only Scan ... Heap Fetches: 226,384  Buffers: shared hit=189,317
-- An index-only scan doing 226k heap fetches is not an index-only scan.
--
-- Same treatment as 20260822230941. Storage parameters only; reversible.
--
-- INCOMPLETE ON ITS OWN - see 20260823080000, which corrects it. The thresholds
-- set here count DEAD tuples, and this table is append-only, so they can never
-- fire.
ALTER TABLE public.union_wallet_transactions SET (
  autovacuum_enabled              = true,
  autovacuum_vacuum_scale_factor  = 0.0,
  autovacuum_vacuum_threshold     = 5000,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold    = 5000,
  autovacuum_vacuum_cost_delay    = 0,
  autovacuum_vacuum_cost_limit    = 10000
);

DO $$
BEGIN
  IF (SELECT reloptions FROM pg_class WHERE oid='public.union_wallet_transactions'::regclass) IS NULL THEN
    RAISE EXCEPTION 'union_wallet_transactions autovacuum reloptions were not applied';
  END IF;
END $$;

-- ROLLBACK
--   ALTER TABLE public.union_wallet_transactions RESET (
--     autovacuum_enabled, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold,
--     autovacuum_analyze_scale_factor, autovacuum_analyze_threshold,
--     autovacuum_vacuum_cost_delay, autovacuum_vacuum_cost_limit);
