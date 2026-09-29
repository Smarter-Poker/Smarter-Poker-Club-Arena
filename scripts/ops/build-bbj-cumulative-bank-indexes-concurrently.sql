-- Separate top-level online builds, each owned and checked independently.
-- No new B-tree restriction on valid money writes: the covering predicate
-- bounds the stored label to 64 bytes and amount is numeric(15,2). Every other
-- labelled incoming row has a complementary narrow index with no text payload.
-- Use the existing 180s lock / 360s statement budgets with full runway before
-- the :50 DDL boundary. Inspect same-name definitions and valid/ready/live flags
-- before the separate function migration; IF NOT EXISTS does not verify them.
-- An unknown/invalid build requires durable readback and diagnosed recovery,
-- never blind retry. No baseline, ledger, bank, schedule or timeout change.

CREATE INDEX CONCURRENTLY IF NOT EXISTS chip_ledger_bbj_incoming_banks_cover
  ON public.chip_ledger(to_entity_id, created_at) INCLUDE(to_label, amount)
  WHERE to_type = 'bbj_pool'
    AND to_label IN ('bbj_pools.main_balance', 'bbj_pools.backup_balance', 'bbj_pools.promo_balance')
    AND octet_length(to_label) <= 64;

CREATE INDEX CONCURRENTLY IF NOT EXISTS chip_ledger_bbj_incoming_other_labels
  ON public.chip_ledger(to_entity_id, created_at)
  WHERE to_type = 'bbj_pool'
    AND (to_label LIKE 'bbj_pools.%' OR from_label LIKE 'bbj_pools.%')
    AND (to_label IN ('bbj_pools.main_balance', 'bbj_pools.backup_balance', 'bbj_pools.promo_balance') AND octet_length(to_label) <= 64) IS NOT TRUE;
