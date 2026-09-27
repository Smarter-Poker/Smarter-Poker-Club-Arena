-- The exact reviewed-return read found two legs after reading 4925 disk blocks
-- through the broad tournament/category index. Reuse the existing query with
-- a matching narrow partial cover. Preserve every financial function, row,
-- permission, retention policy, existing index and natural schedule.
-- This short transaction verifies the separately maintained native online
-- build. It never builds/rebuilds an index or invokes a financial function.
-- Missing, invalid, drifted or actively building state is a refusal.
-- @live-proof: EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.idx_chip_ledger_reviewed_overlay_returns') AND indisvalid AND indisready AND indislive)
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='8s';
DO $verify$
DECLARE v record;
BEGIN
  IF EXISTS (
    SELECT FROM (VALUES
      ('fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,'48e76094473a68f00d75da7343834c97'),
      ('fn_tournament_conservation_delta(uuid)'::regprocedure,'46647067aa049dcb9bda93fa0a1a35b3')) expected(id,hash)
    WHERE md5(pg_get_functiondef(expected.id)) IS DISTINCT FROM expected.hash
  ) THEN
    RAISE EXCEPTION 'REVIEWED_RETURN_INDEX_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT FROM pg_proc p WHERE p.oid IN (
      'fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure,
      'fn_tournament_conservation_delta(uuid)'::regprocedure)
    AND (p.proowner<>'postgres'::regrole OR NOT p.prosecdef
      OR has_function_privilege('anon',p.oid,'EXECUTE')
      OR has_function_privilege('authenticated',p.oid,'EXECUTE')
      OR NOT has_function_privilege('service_role',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'REVIEWED_RETURN_INDEX_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT FROM (VALUES ('tournament_id','uuid'),('amount','numeric(15,2)'),
    ('category','text'),('from_type','text'),('from_entity_id','uuid'),('metadata','jsonb')) expected(name,kind)
    WHERE NOT EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid='public.chip_ledger'::regclass
      AND a.attname=expected.name AND NOT a.attisdropped
      AND format_type(a.atttypid,a.atttypmod)=expected.kind)) THEN
    RAISE EXCEPTION 'REVIEWED_RETURN_INDEX_COLUMNS_CHANGED' USING ERRCODE='55000';
  END IF;
  IF to_regclass('public.idx_chip_ledger_reviewed_overlay_returns') IS NULL THEN
    RAISE EXCEPTION 'REVIEWED_RETURN_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT FROM pg_stat_progress_create_index
      WHERE relid='public.chip_ledger'::regclass) THEN
    RAISE EXCEPTION 'REVIEWED_RETURN_INDEX_ACTIVE_BUILD' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indexrelid='public.idx_chip_ledger_reviewed_overlay_returns'::regclass
      AND i.indrelid='public.chip_ledger'::regclass AND c.relowner='postgres'::regrole
      AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique
      AND md5(pg_get_indexdef(i.indexrelid))='6691784c84cb002e628f2c23a944429d') THEN
    RAISE EXCEPTION 'REVIEWED_RETURN_INDEX_DEFINITION_CHANGED' USING ERRCODE='55000';
  END IF;
END
$verify$;
COMMIT;
