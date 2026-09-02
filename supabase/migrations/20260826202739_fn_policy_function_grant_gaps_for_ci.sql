-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826202739; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- TIER 2 (additive: one new read-only catalog function)
--
-- WHY:
--   On 2026-08-26, 44 tables were unreadable by every signed-in user because
--   their RLS policies called fn_is_platform_admin() and `authenticated` had
--   no EXECUTE on it. Postgres does not short-circuit the OR in a policy, so
--   the privilege error fired even for rows the caller owned. See
--   .agent/audits/2026-08-26-platform-rls-outage.md.
--
--   Nothing in CI could have caught it: a policy referencing a function it
--   cannot call is perfectly valid DDL, and the failure only appears at query
--   time, as the caller.
--
--   This function is what the new CI check calls. It is deliberately a
--   PURPOSE-BUILT READ-ONLY CATALOG QUERY rather than a general SQL executor:
--   `exec_sql` and `run_sql` exist in this database and are both permanently
--   disabled for security, which is correct, and CI has no business holding a
--   capability that broad. This returns catalog metadata and nothing else --
--   no application rows, no user data.
--
-- NOTE ON THE GRANTS BELOW:
--   `REVOKE ALL FROM PUBLIC` is not sufficient on this project. Supabase ships
--   ALTER DEFAULT PRIVILEGES that grant EXECUTE on new functions in `public`
--   to `anon` and `authenticated`, so a new function is reachable by every
--   signed-in user unless those two are revoked BY NAME. The first attempt at
--   this migration was aborted by its own post-apply assertion for exactly
--   that reason -- which is the assertion earning its keep.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_policy_function_grant_gaps()
RETURNS TABLE(
  table_name  text,
  policy_name text,
  fn_name     text,
  fn_args     text,
  role_name   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
  WITH pol AS (
    SELECT p.tablename, p.policyname, p.roles,
           coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') AS expr
    FROM pg_policies p
    WHERE p.schemaname = 'public'
  ),
  called AS (
    -- Generous on purpose. A false positive costs one line of triage; a false
    -- negative costs another 44-table outage. Anything that is not a real
    -- function in `public` fails to join below and drops out.
    SELECT pol.tablename, pol.policyname, pol.roles, lower(m[1]) AS fn_name
    FROM pol, LATERAL regexp_matches(pol.expr, '([a-zA-Z_][a-zA-Z0-9_]*)\s*\(', 'g') AS m
  ),
  resolved AS (
    SELECT DISTINCT c.tablename, c.policyname, c.roles, c.fn_name,
           pr.oid AS fn_oid,
           pg_get_function_identity_arguments(pr.oid) AS fn_args
    FROM called c
    JOIN pg_proc pr      ON pr.proname = c.fn_name
    JOIN pg_namespace n  ON n.oid = pr.pronamespace AND n.nspname = 'public'
  ),
  expanded AS (
    SELECT r.tablename, r.policyname, r.fn_name, r.fn_args, r.fn_oid,
           unnest(r.roles) AS role_name
    FROM resolved r
  )
  SELECT e.tablename::text, e.policyname::text, e.fn_name::text,
         e.fn_args::text, e.role_name::text
  FROM expanded e
  -- `public` as a policy target means every role, and EXECUTE defaults to
  -- PUBLIC, so it is the case that cannot silently break.
  WHERE e.role_name <> 'public'
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = e.role_name)
    AND NOT has_function_privilege(e.role_name, e.fn_oid, 'EXECUTE')
  ORDER BY 1, 2, 3, 5;
$function$;

REVOKE ALL ON FUNCTION public.fn_policy_function_grant_gaps() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_policy_function_grant_gaps() FROM anon;
REVOKE ALL ON FUNCTION public.fn_policy_function_grant_gaps() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_policy_function_grant_gaps() TO service_role;

DO $$
DECLARE v_svc boolean; v_auth boolean; v_anon boolean;
BEGIN
  SELECT has_function_privilege('service_role','public.fn_policy_function_grant_gaps()','EXECUTE') INTO v_svc;
  SELECT has_function_privilege('authenticated','public.fn_policy_function_grant_gaps()','EXECUTE') INTO v_auth;
  SELECT has_function_privilege('anon','public.fn_policy_function_grant_gaps()','EXECUTE') INTO v_anon;
  IF NOT v_svc THEN RAISE EXCEPTION 'POST-APPLY: service_role cannot execute it.'; END IF;
  IF v_auth OR v_anon THEN
    RAISE EXCEPTION 'POST-APPLY: authenticated/anon can execute it. CI-only, service_role only.';
  END IF;
  RAISE NOTICE 'POST-APPLY OK: service_role only.';
END $$;

COMMIT;

-- ROLLBACK:
--   BEGIN; DROP FUNCTION IF EXISTS public.fn_policy_function_grant_gaps(); COMMIT;
