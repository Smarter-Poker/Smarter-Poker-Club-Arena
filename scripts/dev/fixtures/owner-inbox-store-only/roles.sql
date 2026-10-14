-- =============================================================================
--  CLUSTER ROLES for the owner-inbox fixtures (run as the cluster's superuser)
-- =============================================================================
-- scripts/dev/probe-owner-inbox-store-only.sh and
-- scripts/dev/probe-owner-inbox-cleanup.sh create their throwaway cluster with
-- a superuser named supabase_admin, as Supabase does, run this file as that
-- superuser, and then run everything else as postgres. Production's roles, as
-- far as the probes depend on them (pg_roles and pg_auth_members, read
-- 2026-09-28 UTC): postgres is NOT a superuser, bypasses row-level security, owns
-- the public objects, and is a member of anon, authenticated and service_role
-- (admin, inherit and set); service_role bypasses row-level security; anon and
-- authenticated do not. A superuser postgres would pass every authority check
-- for a reason production does not have.
SET client_min_messages = warning;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres' AND rolsuper) THEN
    RAISE EXCEPTION 'postgres must not be a superuser here: initdb the cluster with another superuser';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres LOGIN CREATEROLE CREATEDB REPLICATION BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$roles$;
GRANT anon, authenticated, service_role TO postgres WITH ADMIN OPTION;
ALTER DATABASE postgres OWNER TO postgres;
ALTER SCHEMA public OWNER TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
