\set ON_ERROR_STOP on
-- Captured owner/direct ACL restoration and client/service effective checks.
-- UNRUN. Load schema.sql and definitions.sql first in the protected fixture.
-- The expanded access observation is at 2026-09-15T02:39:31.441006+00:00.
-- Do not synthesize the production managed-role graph or alter auth helpers.
DO $captured_messenger_access$
DECLARE
 expected record;
 grant_row record;
 actual_owner oid;
 actual_acl aclitem[];
 target_role text;
 target_privilege text;
 target_column record;
 expected_allowed boolean;
 table_oid oid := to_regclass('public.notification_preferences');
BEGIN
 IF current_user <> 'postgres' OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
  RAISE EXCEPTION 'messenger access supplement requires the protected PostgreSQL 17 postgres fixture'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=table_oid
   AND c.relkind='r' AND pg_get_userbyid(c.relowner)='postgres'
   AND c.relrowsecurity AND NOT c.relforcerowsecurity)
  OR (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=table_oid AND a.attnum>0 AND NOT a.attisdropped)<>19
  OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=table_oid AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
  OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=table_oid AND NOT t.tgisinternal) THEN
  RAISE EXCEPTION 'captured notification preference relation/column ACL/trigger prerequisite changed'; END IF;

 SELECT c.relowner,c.relacl INTO actual_owner,actual_acl FROM pg_class c WHERE c.oid=table_oid;
 FOR grant_row IN SELECT DISTINCT a.grantee FROM aclexplode(COALESCE(actual_acl,acldefault('r',actual_owner))) a LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.notification_preferences FROM %s',
    CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END);
 END LOOP;
 GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN
  ON TABLE public.notification_preferences TO postgres,service_role;
 GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN
  ON TABLE public.notification_preferences TO anon,authenticated;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=table_oid
   AND ARRAY(SELECT x::text FROM unnest(c.relacl)x ORDER BY x::text)
    =ARRAY(SELECT x::text FROM unnest('{postgres=arwdDxtm/postgres,anon=arwdxtm/postgres,authenticated=arwdxtm/postgres,service_role=arwdDxtm/postgres}'::aclitem[])x ORDER BY x::text)) THEN
  RAISE EXCEPTION 'captured notification preference direct ACL did not reproduce'; END IF;

 FOR expected IN SELECT * FROM (VALUES
  ('public.fn_messenger_message_page(uuid,uuid,timestamptz,uuid,integer)',
   '50f7d04e5714aca5db85e37f9c5b7527','ae752a70fdd81c0f9d8c45c6d3955bfc'),
  ('public.fn_messenger_accounting_threads(uuid,uuid[])',
   '17d04846d71f752ee13cfa2e8714e628','c334d1027a8857d2ffa39761b003fda4'),
  ('public.fn_messenger_search_messages(uuid,uuid[],text,integer)',
   '8a435bb2242375fd1e00055cba8f50e0','37d6a68678cd19a44ce00696f4c42a16')
 ) x(signature,definition_md5,source_md5) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid=to_regprocedure(expected.signature) AND p.prosecdef
     AND p.provolatile='s' AND l.lanname='plpgsql'
     AND p.proconfig=ARRAY['search_path=public']::text[]
     AND md5(p.prosrc)=expected.source_md5 AND md5(pg_get_functiondef(p.oid))=expected.definition_md5) THEN
   RAISE EXCEPTION 'captured messenger reader definition changed: %',expected.signature; END IF;
  EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',expected.signature);
  SELECT p.proowner,p.proacl INTO actual_owner,actual_acl FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature);
  FOR grant_row IN SELECT DISTINCT a.grantee FROM aclexplode(COALESCE(actual_acl,acldefault('f',actual_owner))) a LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',expected.signature,
    CASE WHEN grant_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres,service_role,authenticated',expected.signature);
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(expected.signature)
    AND pg_get_userbyid(p.proowner)='postgres'
    AND ARRAY(SELECT x::text FROM unnest(p.proacl)x ORDER BY x::text)
     =ARRAY(SELECT x::text FROM unnest('{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'::aclitem[])x ORDER BY x::text)) THEN
   RAISE EXCEPTION 'captured messenger reader direct ACL did not reproduce: %',expected.signature; END IF;
  FOREACH target_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(target_role,to_regprocedure(expected.signature),'EXECUTE')
     IS DISTINCT FROM (target_role<>'anon') THEN
    RAISE EXCEPTION 'captured messenger effective EXECUTE differs: %, %',target_role,expected.signature; END IF;
  END LOOP;
 END LOOP;

 -- These three role attributes and effective grants were actually observed.
 -- The managed postgres owner is deliberately excluded from role equivalence:
 -- the disposable bootstrap owner is superuser; production postgres is not.
 FOREACH target_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=target_role
    AND NOT r.rolsuper AND NOT r.rolcanlogin AND r.rolinherit
    AND r.rolbypassrls=(target_role='service_role')) THEN
   RAISE EXCEPTION 'captured messenger client/service role attributes differ: %',target_role; END IF;
  FOREACH target_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
   expected_allowed := target_privilege<>'TRUNCATE' OR target_role='service_role';
   IF has_table_privilege(target_role,table_oid,target_privilege) IS DISTINCT FROM expected_allowed THEN
    RAISE EXCEPTION 'captured preference effective table privilege differs: %, %',target_role,target_privilege; END IF;
  END LOOP;
  FOR target_column IN SELECT a.attnum,a.attname FROM pg_attribute a
    WHERE a.attrelid=table_oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LOOP
   FOREACH target_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
    IF has_column_privilege(target_role,table_oid,target_column.attnum,target_privilege) IS DISTINCT FROM true THEN
     RAISE EXCEPTION 'captured preference effective column privilege differs: %, %, %',target_role,target_column.attname,target_privilege; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=table_oid AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL) THEN
  RAISE EXCEPTION 'captured notification preference NULL column ACLs did not remain unchanged'; END IF;
END $captured_messenger_access$;
