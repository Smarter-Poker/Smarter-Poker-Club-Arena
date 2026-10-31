-- The original weekly cash boundary reads each pending funding transaction's
-- observed_at through union_pnl_transaction_frames, twice (funding/application).
-- A read-only exact-body diagnostic reproduced the original boundary and
-- measured 82.563 seconds in that query. The 47.5 million-row frame table has only
-- a transaction_id primary-key index, so these reads still visit its heap.
-- Its catalog reports roughly 96 percent all-visible pages; a covering index
-- permits the original lookup to use visibility-safe index-only access.
--
-- No function, source generation, financial rule, receipt, cache or budget
-- changes. Native qualification checks original full row bags/club totals,
-- broad-book access and concurrent visibility fallback. No future capacity
-- guarantee follows from a native plan; verify the installed original close.
-- The maintained concurrent-preamble installer protects live funding writers.
-- Invalid or differently shaped index leftovers are refused, never repaired.
-- @live-proof: EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am a ON a.oid=c.relam WHERE i.indexrelid=to_regclass('public.cash_boundary_frame_observed_at_cover') AND i.indrelid='public.union_pnl_transaction_frames'::regclass AND c.relowner='postgres'::regrole AND a.amname='btree' AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND i.indnkeyatts=1 AND i.indnatts=2 AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid=i.indrelid AND attname='transaction_id' AND NOT attisdropped) AND i.indkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid=i.indrelid AND attname='observed_at' AND NOT attisdropped))
CREATE INDEX CONCURRENTLY IF NOT EXISTS cash_boundary_frame_observed_at_cover
 ON public.union_pnl_transaction_frames (transaction_id) INCLUDE(observed_at);

BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,public;

DO $original_authority$
BEGIN
 IF session_user<>'postgres' OR current_user<>'postgres'
  OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL
  OR public.fn_platform_frozen() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'cash_boundary_frame_cover_operator_or_freeze_refused';
 END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true
  OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM
   'original-inventory-245-v1:05f51b14eb6ebcb361fd88f7ba7a7343'
  OR md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamptz)'::regprocedure))
   IS DISTINCT FROM '5e4e878524a91518de209bc5e008db36' THEN
  RAISE EXCEPTION 'cash_boundary_frame_cover_original_authority_changed';
 END IF;
END $original_authority$;

DO $exact_index$
BEGIN
 IF NOT EXISTS(
  SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
   JOIN pg_am a ON a.oid=c.relam
  WHERE i.indexrelid=to_regclass('public.cash_boundary_frame_observed_at_cover')
   AND i.indrelid='public.union_pnl_transaction_frames'::regclass
   AND c.relowner='postgres'::regrole AND c.relkind='i' AND c.relpersistence='p'
   AND c.reloptions IS NULL AND a.amname='btree'
   AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
   AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
   AND NOT i.indnullsnotdistinct AND i.indnkeyatts=1 AND i.indnatts=2
   AND i.indexprs IS NULL AND i.indpred IS NULL
   AND i.indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid=i.indrelid
    AND attname='transaction_id' AND NOT attisdropped)
   AND i.indkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid=i.indrelid
    AND attname='observed_at' AND NOT attisdropped)
   AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcname='xid8_ops'
    AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=c.relam)
   AND i.indcollation[0]=0 AND i.indoption[0]=0
 ) THEN RAISE EXCEPTION 'cash_boundary_frame_cover_exact_valid_shape_required'; END IF;
END $exact_index$;

COMMENT ON INDEX public.cash_boundary_frame_observed_at_cover IS
 'Original weekly cash boundary: visibility-safe observed_at coverage for unchanged transaction-frame lookups; no payment or evidence-generation change.';
COMMIT;
