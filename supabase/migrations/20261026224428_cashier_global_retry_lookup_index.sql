-- Reserved by scripts/reserve-migration-version.sh.
-- A photographed 25-chip send timed out (57014) before recording its intent.
-- fn_cashier_exact_intent_begin checks legacy op_id globally, across clubs and
-- transaction types. Existing per-club/type indexes cannot answer this query:
-- production EXPLAIN showed a parallel sequential scan of chip_transactions.
-- Index the exact lookup without narrowing its ownership/duplicate checks.
-- Equality implies this non-NULL predicate, including for prepared parameters.
-- Non-unique: historical duplicates must remain visible, never rewritten.
-- Build concurrently through the existing merged-migration installer so active
-- financial writers continue. No wallet, RPC, privilege or engine change.
-- @live-proof: EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.chip_transactions_global_op_lookup_idx') AND indrelid='public.chip_transactions'::regclass AND indisvalid AND indisready AND indislive AND NOT indisunique)
CREATE INDEX CONCURRENTLY IF NOT EXISTS chip_transactions_global_op_lookup_idx
 ON public.chip_transactions USING btree ((metadata ->> 'op_id'))
 WHERE (metadata ->> 'op_id') IS NOT NULL;
BEGIN;
SET LOCAL lock_timeout='1s';
DO $guard$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  JOIN pg_am am ON am.oid=c.relam
  WHERE c.oid=to_regclass('public.chip_transactions_global_op_lookup_idx')
   AND i.indrelid='public.chip_transactions'::regclass
   AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique
   AND am.amname='btree' AND i.indnatts=1 AND i.indnkeyatts=1
   AND pg_get_expr(i.indexprs,i.indrelid)='(metadata ->> ''op_id''::text)'
   AND pg_get_expr(i.indpred,i.indrelid)='((metadata ->> ''op_id''::text) IS NOT NULL)'
 ) THEN RAISE EXCEPTION 'cashier_global_op_lookup_index_shape_changed'; END IF;
END $guard$;
COMMIT;
