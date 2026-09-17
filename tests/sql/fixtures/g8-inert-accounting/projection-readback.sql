DO $readback$
DECLARE p record; expected jsonb := __EXPECTED_BODIES__;
BEGIN
 IF (SELECT count(*) FROM pg_proc WHERE pronamespace='smarter_private'::regnamespace) <> 2
    OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE oid='smarter_private'::regnamespace) <> 'postgres'
    OR EXISTS(SELECT FROM pg_namespace n,
       LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
       WHERE n.oid='smarter_private'::regnamespace AND a.grantee <> n.nspowner)
    OR EXISTS(SELECT FROM pg_roles WHERE NOT rolsuper AND rolname <> 'postgres'
       AND (rolcanlogin OR rolname IN ('anon','authenticated','service_role','authenticator'))
       AND has_schema_privilege(oid,'smarter_private','USAGE')) THEN
  RAISE EXCEPTION 'IP_FIXTURE_SCHEMA_READBACK';
 END IF;
 FOR p IN SELECT * FROM pg_proc WHERE pronamespace='smarter_private'::regnamespace LOOP
  IF NOT expected ? p.proname OR p.prosrc IS DISTINCT FROM expected->>p.proname
     OR p.proargtypes::text <> '3802 3802' OR p.prorettype <> 'jsonb'::regtype
     OR p.proretset OR p.prosecdef OR p.provolatile <> 'i' OR p.prokind <> 'f'
     OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname='plpgsql')
     OR pg_get_userbyid(p.proowner) <> 'postgres'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
     OR NOT has_function_privilege('postgres',p.oid,'EXECUTE')
     OR EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee <> p.proowner)
     OR EXISTS(SELECT FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname <> 'postgres'
          AND has_function_privilege(r.oid,p.oid,'EXECUTE')) THEN
   RAISE EXCEPTION 'IP_FIXTURE_FUNCTION_READBACK: %',p.proname;
  END IF;
 END LOOP;
END $readback$;
