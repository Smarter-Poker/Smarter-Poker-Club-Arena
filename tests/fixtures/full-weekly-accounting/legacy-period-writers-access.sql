-- Actual captured owner and ACL, NOT assumed service grants.
-- Source: accounting-40398-installed-period-writers.json, observed_at
-- 2026-09-15 00:39:03.686932+00. Load original definitions immediately before.
-- Protected disposable fixture only; this file does not invoke either writer.
DO $captured_access$
DECLARE expected record;grant_row record;actual_owner oid;actual_acl aclitem[];
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_create_settlement_period(uuid,uuid,date,date)',false,'3ff2d628a4561939095d2c6c0181fba8','9441ee9859635994083376e985e3c6c7'),
  ('public.fn_rakeback_periods_bulk_upsert(jsonb)',true,'89712d79d8ec9e19e7dfe6c0f0fe2611','d0c71ea5b08d917e99c71ea967f5caab')
 ) x(signature,security_definer,definition_md5,source_md5) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature)
    AND p.prosecdef=expected.security_definer AND md5(p.prosrc)=expected.source_md5
    AND md5(pg_get_functiondef(p.oid))=expected.definition_md5) THEN
   RAISE EXCEPTION 'captured original period writer definition changed: %',expected.signature;END IF;
  EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',expected.signature);
  SELECT p.proowner,p.proacl INTO actual_owner,actual_acl FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature);
  -- Remove local/default grants before reproducing the two actual ACL entries.
  -- This prevents fixture defaults from creating uncaptured extra grantees.
  FOR grant_row IN SELECT DISTINCT a.grantee FROM aclexplode(COALESCE(actual_acl,acldefault('f',actual_owner))) a LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',expected.signature,
     CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres,service_role',expected.signature);
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature)
    AND pg_get_userbyid(p.proowner)='postgres'
    AND ARRAY(SELECT a::text FROM unnest(p.proacl)a ORDER BY a::text)=ARRAY['postgres=X/postgres','service_role=X/postgres']
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
    AND has_function_privilege('service_role',p.oid,'EXECUTE')) THEN
   RAISE EXCEPTION 'captured original period writer access did not reproduce: %',expected.signature;END IF;
 END LOOP;
END $captured_access$;
