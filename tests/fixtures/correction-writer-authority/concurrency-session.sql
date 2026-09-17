\set ON_ERROR_STOP on
-- UNRUN. Per-connection helpers only, no production function replacement.
SET statement_timeout='10s';SET lock_timeout='2s';
DO $guard$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR inet_server_addr() IS NOT NULL
 OR current_setting('session_replication_role')<>'origin'
 OR to_regclass('public.ca_correction_request_intents_v1') IS NULL
 OR to_regclass('public.correction_writer_fixture_marker') IS NULL
 THEN RAISE EXCEPTION 'isolated full successor required';END IF;END$guard$;
DO $marker$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.correction_writer_fixture_marker'::regclass
  AND c.relkind='r' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='postgres'))
  OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN('anon','authenticated','service_role')
   AND has_table_privilege(r.oid,'public.correction_writer_fixture_marker','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid='public.correction_writer_fixture_marker'::regclass AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
   WHERE c.attrelid='public.correction_writer_fixture_marker'::regclass
    AND a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='postgres'))
  OR NOT(SELECT count(*)=1 AND bool_and(singleton AND run_id<>'00000000-0000-0000-0000-000000000000'::uuid
   AND database_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
   AND postmaster_started_at=pg_postmaster_start_time()) FROM public.correction_writer_fixture_marker)
 THEN RAISE EXCEPTION 'unconfirmed concurrency fixture identity';END IF;
END$marker$;
CREATE FUNCTION pg_temp.cw_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
 SELECT ('e6361000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.cw_check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'correction writer fixture failed: %',label;END IF;
 RAISE NOTICE 'correction writer fixture passed: %',label;
END$$;
CREATE FUNCTION pg_temp.cw_actor(who uuid,role_name text DEFAULT 'service_role') RETURNS void LANGUAGE plpgsql AS $$BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(who::text,''),true);
 PERFORM set_config('request.jwt.claim.role',role_name,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',who,'role',role_name)::text,true);
END$$;
CREATE FUNCTION pg_temp.cw_call(q jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_ca_post_correction(q->>'from_type',(q->>'from_entity')::uuid,
  q->>'to_type',(q->>'to_entity')::uuid,(q->>'amount')::numeric,q->>'reason',
  (q->>'incident_id')::uuid,(q->>'write_failure_id')::bigint,
  (q->>'club_id')::uuid,(q->>'union_id')::uuid,
  CASE WHEN (q->>'metadata_sql_null')::boolean IS TRUE THEN NULL ELSE q->'metadata' END);
$$;
-- All public/private base roots, including dynamically added component36 intent.
-- auth is included too; sequence allocations are intentionally not row snapshots.
CREATE FUNCTION pg_temp.cw_book() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE r record;rows_json jsonb;result jsonb:='{}';BEGIN
 FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN('public','smarter_private','auth','operational_source_intake') AND c.relkind IN('r','p') AND NOT c.relispartition
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM %I.%I t',r.nspname,r.relname) INTO rows_json;
  result:=result||jsonb_build_object(r.nspname||'.'||r.relname,rows_json);
 END LOOP;RETURN result;
END$$;
DO $temp$ DECLARE n name;BEGIN SELECT nspname INTO STRICT n FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO service_role',n);END$temp$;
REVOKE ALL ON FUNCTION pg_temp.cw_book() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.cw_book(),pg_temp.cw_id(integer),pg_temp.cw_call(jsonb),pg_temp.cw_actor(uuid,text),pg_temp.cw_check(boolean,text) TO service_role;
