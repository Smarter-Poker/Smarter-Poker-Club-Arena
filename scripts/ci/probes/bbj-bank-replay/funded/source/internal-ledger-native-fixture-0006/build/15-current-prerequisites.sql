SET search_path=pg_catalog,public,extensions;
CREATE SCHEMA IF NOT EXISTS "public" AUTHORIZATION "pg_database_owner";
ALTER SCHEMA "public" OWNER TO "pg_database_owner";
-- Exact ACL SCHEMA: "public"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT nspowner, nspacl INTO own, old_acl FROM pg_catalog.pg_namespace WHERE oid='"public"'::regnamespace;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"public"'; END IF;
 new_acl := '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner,postgres=U/pg_database_owner,anon=U/pg_database_owner,authenticated=U/pg_database_owner,service_role=U/pg_database_owner}'::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"public"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('n',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"public"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"public"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SCHEMA "public" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SCHEMA "public" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT nspowner, nspacl INTO own, actual_acl FROM pg_catalog.pg_namespace WHERE oid='"public"'::regnamespace;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"public"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
CREATE SCHEMA IF NOT EXISTS "extensions" AUTHORIZATION "postgres";
ALTER SCHEMA "extensions" OWNER TO "postgres";
-- Exact ACL SCHEMA: "extensions"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT nspowner, nspacl INTO own, old_acl FROM pg_catalog.pg_namespace WHERE oid='"extensions"'::regnamespace;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"extensions"'; END IF;
 new_acl := '{postgres=UC/postgres,anon=U/postgres,authenticated=U/postgres,service_role=U/postgres,dashboard_user=UC/postgres}'::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"extensions"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('n',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"extensions"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"extensions"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SCHEMA "extensions" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SCHEMA "extensions" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT nspowner, nspacl INTO own, actual_acl FROM pg_catalog.pg_namespace WHERE oid='"extensions"'::regnamespace;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"extensions"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
CREATE SCHEMA IF NOT EXISTS "auth" AUTHORIZATION "supabase_admin";
ALTER SCHEMA "auth" OWNER TO "supabase_admin";
-- Exact ACL SCHEMA: "auth"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT nspowner, nspacl INTO own, old_acl FROM pg_catalog.pg_namespace WHERE oid='"auth"'::regnamespace;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"auth"'; END IF;
 new_acl := '{supabase_admin=UC/supabase_admin,anon=U/supabase_admin,authenticated=U/supabase_admin,service_role=U/supabase_admin,supabase_auth_admin=UC/supabase_admin,dashboard_user=UC/supabase_admin,postgres=U/supabase_admin}'::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"auth"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('n',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"auth"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"auth"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SCHEMA "auth" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SCHEMA "auth" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT nspowner, nspacl INTO own, actual_acl FROM pg_catalog.pg_namespace WHERE oid='"auth"'::regnamespace;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"auth"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
CREATE SCHEMA IF NOT EXISTS "supabase_migrations" AUTHORIZATION "postgres";
ALTER SCHEMA "supabase_migrations" OWNER TO "postgres";
-- Exact ACL SCHEMA: "supabase_migrations"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT nspowner, nspacl INTO own, old_acl FROM pg_catalog.pg_namespace WHERE oid='"supabase_migrations"'::regnamespace;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"supabase_migrations"'; END IF;
 new_acl := NULL::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"supabase_migrations"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('n',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"supabase_migrations"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"supabase_migrations"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SCHEMA "supabase_migrations" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SCHEMA "supabase_migrations" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT nspowner, nspacl INTO own, actual_acl FROM pg_catalog.pg_namespace WHERE oid='"supabase_migrations"'::regnamespace;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"supabase_migrations"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
CREATE SCHEMA IF NOT EXISTS "smarter_private" AUTHORIZATION "postgres";
ALTER SCHEMA "smarter_private" OWNER TO "postgres";
-- Exact ACL SCHEMA: "smarter_private"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT nspowner, nspacl INTO own, old_acl FROM pg_catalog.pg_namespace WHERE oid='"smarter_private"'::regnamespace;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"smarter_private"'; END IF;
 new_acl := '{postgres=UC/postgres,anon=U/postgres,authenticated=U/postgres,service_role=U/postgres}'::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"smarter_private"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('n',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"smarter_private"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"smarter_private"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SCHEMA "smarter_private" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SCHEMA "smarter_private" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT nspowner, nspacl INTO own, actual_acl FROM pg_catalog.pg_namespace WHERE oid='"smarter_private"'::regnamespace;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"smarter_private"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
CREATE SEQUENCE IF NOT EXISTS "public"."ca_guard_def_history_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "public"."ca_guard_def_history_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "public"."ca_guard_def_history_id_seq" OWNER TO "postgres";
-- Exact ACL SEQUENCE: "public"."ca_guard_def_history_id_seq"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT relowner, relacl INTO own, old_acl FROM pg_catalog.pg_class WHERE oid='"public"."ca_guard_def_history_id_seq"'::regclass;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"public"."ca_guard_def_history_id_seq"'; END IF;
 new_acl := '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}'::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"public"."ca_guard_def_history_id_seq"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('S',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"public"."ca_guard_def_history_id_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"public"."ca_guard_def_history_id_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SEQUENCE "public"."ca_guard_def_history_id_seq" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SEQUENCE "public"."ca_guard_def_history_id_seq" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT relowner, relacl INTO own, actual_acl FROM pg_catalog.pg_class WHERE oid='"public"."ca_guard_def_history_id_seq"'::regclass;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"public"."ca_guard_def_history_id_seq"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
CREATE SEQUENCE IF NOT EXISTS "public"."ca_account_snapshots_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "public"."ca_account_snapshots_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "public"."ca_account_snapshots_id_seq" OWNER TO "postgres";
-- Exact ACL SEQUENCE: "public"."ca_account_snapshots_id_seq"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT relowner, relacl INTO own, old_acl FROM pg_catalog.pg_class WHERE oid='"public"."ca_account_snapshots_id_seq"'::regclass;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"public"."ca_account_snapshots_id_seq"'; END IF;
 new_acl := '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}'::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"public"."ca_account_snapshots_id_seq"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('S',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"public"."ca_account_snapshots_id_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"public"."ca_account_snapshots_id_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SEQUENCE "public"."ca_account_snapshots_id_seq" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SEQUENCE "public"."ca_account_snapshots_id_seq" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT relowner, relacl INTO own, actual_acl FROM pg_catalog.pg_class WHERE oid='"public"."ca_account_snapshots_id_seq"'::regclass;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"public"."ca_account_snapshots_id_seq"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
CREATE SEQUENCE IF NOT EXISTS "public"."ca_currency_meter_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "public"."ca_currency_meter_id_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "public"."ca_currency_meter_id_seq" OWNER TO "postgres";
-- Exact ACL SEQUENCE: "public"."ca_currency_meter_id_seq"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT relowner, relacl INTO own, old_acl FROM pg_catalog.pg_class WHERE oid='"public"."ca_currency_meter_id_seq"'::regclass;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"public"."ca_currency_meter_id_seq"'; END IF;
 new_acl := '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}'::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"public"."ca_currency_meter_id_seq"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('S',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"public"."ca_currency_meter_id_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"public"."ca_currency_meter_id_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SEQUENCE "public"."ca_currency_meter_id_seq" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SEQUENCE "public"."ca_currency_meter_id_seq" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT relowner, relacl INTO own, actual_acl FROM pg_catalog.pg_class WHERE oid='"public"."ca_currency_meter_id_seq"'::regclass;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"public"."ca_currency_meter_id_seq"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
CREATE SEQUENCE IF NOT EXISTS "smarter_private"."f06_lifecycle_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "smarter_private"."f06_lifecycle_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "smarter_private"."f06_lifecycle_seq" OWNER TO "postgres";
-- Exact ACL SEQUENCE: "smarter_private"."f06_lifecycle_seq"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT relowner, relacl INTO own, old_acl FROM pg_catalog.pg_class WHERE oid='"smarter_private"."f06_lifecycle_seq"'::regclass;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"smarter_private"."f06_lifecycle_seq"'; END IF;
 new_acl := '{postgres=rwU/postgres}'::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"smarter_private"."f06_lifecycle_seq"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('S',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"smarter_private"."f06_lifecycle_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"smarter_private"."f06_lifecycle_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SEQUENCE "smarter_private"."f06_lifecycle_seq" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SEQUENCE "smarter_private"."f06_lifecycle_seq" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT relowner, relacl INTO own, actual_acl FROM pg_catalog.pg_class WHERE oid='"smarter_private"."f06_lifecycle_seq"'::regclass;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"smarter_private"."f06_lifecycle_seq"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
CREATE SEQUENCE IF NOT EXISTS "public"."player_number_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "public"."player_number_seq" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;
ALTER SEQUENCE "public"."player_number_seq" OWNER TO "postgres";
-- Exact ACL SEQUENCE: "public"."player_number_seq"
DO $acl$
DECLARE a record; role_name text; own oid; old_acl aclitem[]; new_acl aclitem[];
        work_old aclitem[]; actual_acl aclitem[];
BEGIN
 IF current_user <> 'postgres' OR NOT EXISTS
    (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'ACL installation requires the owned fixture postgres superuser';
 END IF;
 SELECT relowner, relacl INTO own, old_acl FROM pg_catalog.pg_class WHERE oid='"public"."player_number_seq"'::regclass;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing ACL target: %', '"public"."player_number_seq"'; END IF;
 new_acl := '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}'::aclitem[];
 -- Exact no-op retains catalog NULL and original entry ordering.
 IF old_acl::text IS NOT DISTINCT FROM new_acl::text THEN RETURN; END IF;
 
 IF new_acl IS NULL THEN
  RAISE EXCEPTION 'Captured object ACL is NULL/default but archive ACL differs: %', '"public"."player_number_seq"';
 END IF;

 work_old := COALESCE(old_acl,pg_catalog.acldefault('S',own));
 -- SQL '{}' arrays have zero dimensions. Never pass one (or NULL) to aclexplode.
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  IF pg_catalog.array_ndims(work_old) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(work_old) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Unreviewed old ACL shape/grantor graph: %', '"public"."player_number_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  IF pg_catalog.array_ndims(new_acl) <> 1 OR EXISTS
     (SELECT FROM pg_catalog.aclexplode(new_acl) WHERE grantor<>own) THEN
   RAISE EXCEPTION 'Captured ACL requires an unreviewed grantor graph: %', '"public"."player_number_seq"';
  END IF;
 END IF;
 IF COALESCE(pg_catalog.cardinality(work_old),0)>0 THEN
  FOR a IN SELECT DISTINCT grantee FROM pg_catalog.aclexplode(work_old) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   EXECUTE 'REVOKE ALL ON SEQUENCE "public"."player_number_seq" FROM '||role_name||' RESTRICT';
  END LOOP;
 END IF;
 IF COALESCE(pg_catalog.cardinality(new_acl),0)>0 THEN
  FOR a IN SELECT * FROM pg_catalog.aclexplode(new_acl) LOOP
   role_name:=CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END;
   -- PostgreSQL superuser GRANT records the actual owner, matching every
   -- captured grantor; retain each privilege's explicit grant-option bit.
   EXECUTE 'GRANT '||a.privilege_type||' ON SEQUENCE "public"."player_number_seq" TO '||role_name||
     CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
 END IF;
 SELECT relowner, relacl INTO own, actual_acl FROM pg_catalog.pg_class WHERE oid='"public"."player_number_seq"'::regclass;
 IF actual_acl::text IS DISTINCT FROM new_acl::text THEN
  RAISE EXCEPTION 'Exact ACL catalog shape/order/privileges differ: % expected %, actual %',
    '"public"."player_number_seq"', new_acl::text, actual_acl::text;
 END IF;
END $acl$;
