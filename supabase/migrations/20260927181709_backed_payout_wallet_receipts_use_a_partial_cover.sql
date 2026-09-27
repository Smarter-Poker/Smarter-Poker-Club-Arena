-- The original six-category wallet read fetched72,104 heap disk blocks in
-- one bounded production observation. Cover that exact existing projection
-- without changing any financial function, row, grant, retention or schedule.
-- The UUID key, numeric(15,2) amount and predicate-bounded type/category labels
-- prevent unbounded index tuples. All existing indexes remain untouched.
-- Verify the separately qualified online build; missing/invalid/drifted/active
-- states refuse. This transaction does not create/rebuild an index or pay.
-- @live-proof: EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.idx_wallet_tx_tournament_receipts_cover') AND indisvalid AND indisready AND indislive)
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='8s';
DO $verify$
DECLARE v record;
BEGIN
  IF EXISTS (
    SELECT FROM (VALUES
      ('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,'9078403312e51a873e6e7462555dcf7e'),
      ('fn_tournament_conservation_delta(uuid)'::regprocedure,'46647067aa049dcb9bda93fa0a1a35b3')) expected(id,hash)
    WHERE md5(pg_get_functiondef(expected.id)) IS DISTINCT FROM expected.hash
  ) THEN
    RAISE EXCEPTION 'WALLET_RECEIPT_COVER_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT FROM pg_proc p WHERE p.oid IN (
      'fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,
      'fn_tournament_conservation_delta(uuid)'::regprocedure)
    AND (p.proowner<>'postgres'::regrole OR NOT p.prosecdef
      OR has_function_privilege('anon',p.oid,'EXECUTE')
      OR has_function_privilege('authenticated',p.oid,'EXECUTE')
      OR NOT has_function_privilege('service_role',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'WALLET_RECEIPT_COVER_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT FROM (VALUES ('related_entity_id','uuid'),('amount','numeric(15,2)'),
    ('category','text'),('type','text')) expected(name,kind)
    WHERE NOT EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid='public.wallet_transactions'::regclass
      AND a.attname=expected.name AND NOT a.attisdropped
      AND format_type(a.atttypid,a.atttypmod)=expected.kind)) THEN
    RAISE EXCEPTION 'WALLET_RECEIPT_COVER_COLUMNS_CHANGED' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.idx_wallet_tx_tournament_receipts_cover') IS NULL THEN
    RAISE EXCEPTION 'WALLET_RECEIPT_COVER_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT FROM pg_stat_progress_create_index
      WHERE relid='public.wallet_transactions'::regclass) THEN
    RAISE EXCEPTION 'WALLET_RECEIPT_COVER_ACTIVE_BUILD' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indexrelid='public.idx_wallet_tx_tournament_receipts_cover'::regclass
      AND i.indrelid='public.wallet_transactions'::regclass AND c.relowner='postgres'::regrole
      AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique
      AND md5(pg_get_indexdef(i.indexrelid))='bf79245c5b9d386e2f8dd8e3efe85036') THEN
    RAISE EXCEPTION 'WALLET_RECEIPT_COVER_DEFINITION_CHANGED' USING ERRCODE='55000';
  END IF;
END
$verify$;
COMMIT;
