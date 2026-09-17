-- FIXTURE ONLY. Exact installed four-function authority after the unchanged
-- PR4761 migration; source hashes and metadata are retained in separate captures.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $isolated$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR current_setting('session_replication_role')<>'origin'
 THEN RAISE EXCEPTION 'finish_lane_readback_requires_isolated_pg17'; END IF;
END $isolated$;
DO $installed_readback$
DECLARE expected record; actual record;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_ca_lock_settlement_lane_for_finish(uuid)','76e4c6b5291bab20f0cfc65dd060022b','58962520e072fe177eaa29809db909f3',false,'["search_path=public, pg_temp"]'::jsonb),
  ('public.fn_ca_lock_settlement_lane_global()','7c759bb7a639c3124de2607bdbf12577','2270895ea61dfdfc47b2a17754c9de4a',false,'["search_path=public, pg_temp"]'::jsonb),
  ('public.fn_complete_tournament_terminal(uuid,uuid,text)','c64e049911fd99c1d784cdb042ca714b','36384d5eaef31083e0ee5424d814138d',true,'["search_path=public, pg_temp","statement_timeout=45s"]'::jsonb),
  ('public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)','be748996b334541f84debbc2e9eb5457','f4dbfcaed8d50d95183a0b3fa6a6c290',true,'["search_path=public","statement_timeout=45s"]'::jsonb)
 ) v(signature,definition_md5,body_md5,security_definer,config) LOOP
  SELECT p.*,md5(pg_get_functiondef(p.oid)) AS definition_md5,
   ARRAY(SELECT a::text FROM unnest(p.proacl) a ORDER BY a::text COLLATE "C") AS grants
   INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature);
  IF NOT FOUND THEN RAISE EXCEPTION 'finish lane fixture function missing: %',expected.signature; END IF;
  IF actual.definition_md5 IS DISTINCT FROM expected.definition_md5
   OR md5(actual.prosrc) IS DISTINCT FROM expected.body_md5
   OR actual.proowner IS DISTINCT FROM 'postgres'::regrole
   OR actual.prosecdef IS DISTINCT FROM expected.security_definer
   OR to_jsonb(actual.proconfig) IS DISTINCT FROM expected.config
   OR actual.grants IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
   OR has_function_privilege('anon',actual.oid,'EXECUTE')
   OR has_function_privilege('authenticated',actual.oid,'EXECUTE')
   OR NOT has_function_privilege('service_role',actual.oid,'EXECUTE')
  THEN RAISE EXCEPTION 'finish lane fixture function authority differs: %',expected.signature; END IF;
 END LOOP;
END;
$installed_readback$;
COMMIT;
