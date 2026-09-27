-- Verify two separately built online BBJ indexes. No build or financial write.
-- See scripts/ops/build-bbj-audit-indexes-concurrently.sql for the exact build.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '8s';
DO $migration$
DECLARE
  v_src text;
  v_oid oid := 'public.fn_bbj_reconcile(uuid)'::regprocedure;
  v_acl aclitem[];
  v_config text[];
  v_owner oid;
  v_bad text;
BEGIN
  SELECT pg_get_functiondef(oid), proacl, proconfig, proowner
    INTO v_src, v_acl, v_config, v_owner FROM pg_proc WHERE oid = v_oid;
  IF md5(v_src) IS DISTINCT FROM 'df98293beac30ceff81db8779a9fb6f2'
     OR v_owner IS DISTINCT FROM 'postgres'::regrole::oid
     OR v_acl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR v_config IS DISTINCT FROM ARRAY['search_path=public']::text[] THEN
    RAISE EXCEPTION 'BBJ_METER_READ_PREIMAGE_DRIFT' USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(w.name, ', ' ORDER BY w.name) INTO v_bad
    FROM (VALUES
      ('chip_ledger_bbj_to_pool_meter', 'CREATE INDEX chip_ledger_bbj_to_pool_meter ON public.chip_ledger USING btree (to_entity_id, created_at) WHERE ((to_type = ''bbj_pool''::text) AND ((to_label ~~ ''bbj_pools.%''::text) OR (from_label ~~ ''bbj_pools.%''::text)))'),
      ('chip_ledger_bbj_from_pool_meter', 'CREATE INDEX chip_ledger_bbj_from_pool_meter ON public.chip_ledger USING btree (from_entity_id, created_at) WHERE ((from_type = ''bbj_pool''::text) AND ((to_label ~~ ''bbj_pools.%''::text) OR (from_label ~~ ''bbj_pools.%''::text)))')
    ) AS w(name, definition)
    LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || w.name)
    LEFT JOIN pg_index i ON i.indexrelid = c.oid
   WHERE i.indexrelid IS NULL OR NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive
      OR i.indrelid <> 'public.chip_ledger'::regclass
      OR pg_get_indexdef(c.oid) IS DISTINCT FROM w.definition;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'BBJ_METER_READ_INDEX_NOT_QUALIFIED: %', v_bad USING ERRCODE = '55000';
  END IF;
  -- This is an index-only change. Refuse any concurrent change to the
  -- exact captured financial function and keep its full authority intact.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_oid
      AND pg_get_functiondef(oid)=v_src AND proacl IS NOT DISTINCT FROM v_acl
      AND proconfig IS NOT DISTINCT FROM v_config AND proowner=v_owner) THEN
    RAISE EXCEPTION 'BBJ_METER_READ_INSTALLATION_DRIFT' USING ERRCODE = '55000';
  END IF;
END
$migration$;
COMMIT;
