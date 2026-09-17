-- Only the existing run-isolated.sh cluster contract is supported.
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
DO $guard$
BEGIN
 IF current_user <> 'journal_test' OR session_user <> 'journal_test'
    OR current_database() <> 'postgres'
    OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
    OR inet_server_addr() IS NOT NULL THEN
  RAISE EXCEPTION 'IP_FIXTURE_CONNECTION';
 END IF;
 IF EXISTS(SELECT FROM pg_namespace WHERE nspname='smarter_private')
    OR EXISTS(SELECT FROM pg_roles WHERE rolname IN ('postgres','authenticator')) THEN
  RAISE EXCEPTION 'IP_FIXTURE_OWNED_NAMES_EXIST';
 END IF;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3
    OR EXISTS(SELECT FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')
      AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolcanlogin OR rolreplication OR rolbypassrls
           OR NOT rolinherit OR rolconnlimit <> -1 OR rolvaliduntil IS NOT NULL OR rolconfig IS NOT NULL))
    OR EXISTS(SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.roleid,m.member)
      WHERE r.rolname IN ('journal_test','anon','authenticated','service_role'))
    OR EXISTS(SELECT FROM pg_default_acl d JOIN pg_roles r ON r.oid=d.defaclrole
      WHERE r.rolname IN ('journal_test','anon','authenticated','service_role')) THEN
  RAISE EXCEPTION 'IP_FIXTURE_ROLE_DEFAULT_ACL_PREIMAGE';
 END IF;
END $guard$;
CREATE TEMP TABLE ip_fixture_preimage ON COMMIT DROP AS
 SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY oid) FROM pg_roles r) roles,
        (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb) FROM pg_auth_members m) memberships,
        (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY oid),'[]'::jsonb) FROM pg_default_acl d) defaults;
SAVEPOINT ip_private_install;
-- Explicit disposable fixture roles only; never production preimages.
CREATE ROLE postgres NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA smarter_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA smarter_private FROM PUBLIC;
