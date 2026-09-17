-- Actual read-only supplemental owner/ACL capture at 2026-09-15 01:01:08.623296+00.
-- Protected fixture only. Load captured wrapper/recompute definitions first.
-- Replaces earlier assumed/withheld access with the observed three-function ACL.
DO $captured_access$
DECLARE expected record; grant_row record; actual_owner oid; actual_acl aclitem[];
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_rakeback_recompute_all_clubs(date,date)','7b626bf398892a294e95e6050073431c','94bccb645adfde96a32b2405603cf514'),
  ('public.fn_union_settle_player_pnl_guarded(uuid,timestamp with time zone,timestamp with time zone,numeric)','933946a2ece0c3d75ea4aec3b01c061d','cea5e4d553620f23d85830d2f1006747'),
  ('public.fn_union_settle_player_pnl_weekly(uuid,numeric)','8ed8e3f5d155aa4c70c063c6a1362a56','8ea52390734d9013d1016f2db4963ce1')
 ) x(signature,definition_md5,source_md5) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature)
    AND p.prosecdef AND md5(p.prosrc)=expected.source_md5
    AND md5(pg_get_functiondef(p.oid))=expected.definition_md5) THEN
   RAISE EXCEPTION 'captured supplemental function definition changed: %',expected.signature;
  END IF;
  EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',expected.signature);
  SELECT p.proowner,p.proacl INTO actual_owner,actual_acl FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature);
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
   RAISE EXCEPTION 'captured supplemental function access did not reproduce: %',expected.signature;
  END IF;
 END LOOP;
END $captured_access$;

