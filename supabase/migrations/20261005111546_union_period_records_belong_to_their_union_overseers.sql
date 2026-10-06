-- 20261005111546_union_period_records_belong_to_their_union_overseers.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Automatic weekly accounting writes one aggregate settlement_periods row for
-- a union with union_id set and club_id NULL. UnionPeriodRecords asks for that
-- exact row shape, but both existing SELECT policies derive access through
-- club_id, so Postgres silently removes every valid union-period row. This adds
-- one SELECT-only policy for the exact aggregate shape and the same
-- identity-bound oversight predicate used by the route guard and accounting
-- workspace, including the platform-admin authority that those surfaces
-- intentionally admit.
--
-- The retired generate_period_settlements(uuid) browser RPC is SECURITY
-- DEFINER and still executable by authenticated even though current Club
-- Arena refuses it before dispatch and no current Hub caller remains. Keep the
-- service-role path for internal compatibility while closing browser access.
-- No data, balance, writer, settlement function body, or existing policy is
-- changed.
--
-- @live-proof: (SELECT count(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'settlement_periods' AND policyname = 'union_settlement_period_read' AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[] AND lower(qual) LIKE '%club_id is null%' AND lower(qual) LIKE '%union_id is not null%' AND lower(qual) LIKE '%ca_can_oversee_union%')
-- @live-proof: (NOT has_function_privilege('anon','public.generate_period_settlements(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','public.generate_period_settlements(uuid)','EXECUTE') AND has_function_privilege('service_role','public.generate_period_settlements(uuid)','EXECUTE'))

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('public.settlement_periods') IS NULL THEN
    RAISE EXCEPTION 'UNION_PERIOD_READ_SETTLEMENT_PERIODS_MISSING';
  END IF;
  IF to_regprocedure('public.ca_can_oversee_union(uuid)') IS NULL THEN
    RAISE EXCEPTION 'UNION_PERIOD_READ_OVERSEER_PREDICATE_MISSING';
  END IF;
  IF to_regprocedure('public.generate_period_settlements(uuid)') IS NULL THEN
    RAISE EXCEPTION 'UNION_PERIOD_READ_LEGACY_GENERATOR_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
     WHERE c.oid = 'public.settlement_periods'::regclass
       AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'UNION_PERIOD_READ_RLS_NOT_ENABLED';
  END IF;
END
$preflight$;

DROP POLICY IF EXISTS union_settlement_period_read ON public.settlement_periods;
CREATE POLICY union_settlement_period_read
  ON public.settlement_periods
  FOR SELECT
  TO authenticated
  USING (
    club_id IS NULL
    AND union_id IS NOT NULL
    AND public.ca_can_oversee_union(union_id)
  );

REVOKE ALL ON FUNCTION public.generate_period_settlements(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_period_settlements(uuid)
  TO service_role;

DO $postimage$
DECLARE
  v_policy_count integer;
  v_command "char";
  v_roles oid[];
  v_qual text;
  v_authenticated oid;
BEGIN
  SELECT oid INTO v_authenticated FROM pg_roles WHERE rolname = 'authenticated';
  IF v_authenticated IS NULL THEN
    RAISE EXCEPTION 'UNION_PERIOD_READ_AUTHENTICATED_ROLE_MISSING';
  END IF;

  SELECT count(*)
    INTO v_policy_count
    FROM pg_policy p
   WHERE p.polrelid = 'public.settlement_periods'::regclass
     AND p.polname = 'union_settlement_period_read';
  IF v_policy_count <> 1 THEN
    RAISE EXCEPTION 'UNION_PERIOD_READ_POLICY_COUNT_%', v_policy_count;
  END IF;

  SELECT p.polcmd, p.polroles, pg_get_expr(p.polqual, p.polrelid)
    INTO v_command, v_roles, v_qual
    FROM pg_policy p
   WHERE p.polrelid = 'public.settlement_periods'::regclass
     AND p.polname = 'union_settlement_period_read';

  IF v_command <> 'r'
     OR v_roles IS DISTINCT FROM ARRAY[v_authenticated]::oid[]
     OR position('club_id IS NULL' IN v_qual) = 0
     OR position('union_id IS NOT NULL' IN v_qual) = 0
     OR position('ca_can_oversee_union' IN v_qual) = 0 THEN
    RAISE EXCEPTION 'UNION_PERIOD_READ_POLICY_POSTIMAGE_INVALID: %', v_qual;
  END IF;

  IF has_function_privilege(
       'anon', 'public.generate_period_settlements(uuid)', 'EXECUTE')
     OR has_function_privilege(
       'authenticated', 'public.generate_period_settlements(uuid)', 'EXECUTE')
     OR NOT has_function_privilege(
       'service_role', 'public.generate_period_settlements(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'UNION_PERIOD_READ_LEGACY_GENERATOR_ACL_INVALID';
  END IF;
END
$postimage$;

COMMIT;
