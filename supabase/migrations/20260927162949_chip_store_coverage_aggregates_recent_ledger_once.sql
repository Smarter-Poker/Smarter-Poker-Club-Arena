-- Aggregate the existing coverage observer's identical recent ledger input once.
-- Native and retained production plans show one complete ledger scan per
-- uncounted store. This preserves the entire result and unchanged observer;
-- it does not claim to explain the conservation sweep's whole 120s timeout.
-- No financial records, schedules, indexes, grants or function timeouts change.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_chip_store_coverage_gaps()'::regprocedure))='695e059789886db5e90e9999bac45d34')
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $migration$
DECLARE
  v_oid oid := 'public.fn_ca_chip_store_coverage_gaps()'::regprocedure;
  v_src text; v_next text; v_acl aclitem[]; v_owner oid; v_config text[];
BEGIN
  SELECT pg_get_functiondef(oid),proacl,proowner,proconfig INTO v_src,v_acl,v_owner,v_config
    FROM pg_proc WHERE oid=v_oid;
  IF md5(v_src) IS DISTINCT FROM '9f44a12318e13f1ef9942ed2a2758d1a'
    OR v_acl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
    OR v_owner IS DISTINCT FROM 'postgres'::regrole::oid
    OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'CHIP_STORE_COVERAGE_SOURCE_OR_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  -- The regrouped sum is exact numeric addition, never floating-point.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.chip_ledger'::regclass
      AND attname='amount' AND NOT attisdropped
      AND format_type(atttypid,atttypmod)='numeric(15,2)') THEN
    RAISE EXCEPTION 'CHIP_STORE_COVERAGE_AMOUNT_TYPE_CHANGED' USING ERRCODE='55000';
  END IF;
  v_next := replace(v_src,$old$  RETURN QUERY
  SELECT g.store, 'uncounted store moved'::text,
         ('the supply basis does not count ' || g.store || ' and it moved '
          || round(x.net, 2)::text || ' in the last 24h, so that movement reads as drift')::text
    FROM public.ca_chip_store_coverage g
    JOIN LATERAL (
      SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = g.store), 0)
           - COALESCE(sum(l.amount) FILTER (WHERE l.from_type = g.store), 0) AS net
        FROM public.chip_ledger l
       WHERE l.created_at > now() - interval '24 hours'
         -- the supply basis excludes exactly these legs (fn_ca_supply_snapshot)
         AND NOT (l.category = 'correction'
                  AND l.metadata ->> 'posted_via' = 'fn_ca_post_correction')
    ) x ON true
   WHERE g.treatment = 'uncounted' AND x.net <> 0;$old$,$new$  RETURN QUERY
  WITH recent_store_pairs AS MATERIALIZED (
    SELECT l.from_type, l.to_type, sum(l.amount) AS amount
      FROM public.chip_ledger l
     WHERE l.created_at > now() - interval '24 hours'
       -- Keep the original NULL-sensitive exclusion exactly.
       AND NOT (l.category = 'correction'
                AND l.metadata ->> 'posted_via' = 'fn_ca_post_correction')
     GROUP BY l.from_type, l.to_type
  )
  SELECT g.store, 'uncounted store moved'::text,
         ('the supply basis does not count ' || g.store || ' and it moved '
          || round(x.net, 2)::text || ' in the last 24h, so that movement reads as drift')::text
    FROM public.ca_chip_store_coverage g
    JOIN LATERAL (
      SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = g.store), 0)
           - COALESCE(sum(l.amount) FILTER (WHERE l.from_type = g.store), 0) AS net
        FROM recent_store_pairs l
    ) x ON true
   WHERE g.treatment = 'uncounted' AND x.net <> 0;$new$);
  IF v_next=v_src OR md5(v_next) IS DISTINCT FROM '695e059789886db5e90e9999bac45d34' THEN
    RAISE EXCEPTION 'CHIP_STORE_COVERAGE_REPLACEMENT_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_next;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner=v_owner
      AND proacl IS NOT DISTINCT FROM v_acl AND proconfig IS NOT DISTINCT FROM v_config
      AND prosecdef AND provolatile='s' AND md5(pg_get_functiondef(oid))='695e059789886db5e90e9999bac45d34') THEN
    RAISE EXCEPTION 'CHIP_STORE_COVERAGE_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
END;
$migration$;
COMMIT;
