-- 20260921030817_the_escalator_is_not_reachable_by_a_browser
--
-- A DROP-AND-RECREATE RESET THE ACL, AND `REVOKE ... FROM PUBLIC` DID NOT
-- PUT IT BACK.
--
-- 20260921023309 changed the return type of fn_ca_escalate_reconcile_criticals,
-- which cannot be done with CREATE OR REPLACE, so it dropped and recreated the
-- function. A DROP takes the ACL with it. On recreate, this database's default
-- privileges for functions in `public` grant EXECUTE to `anon` and
-- `authenticated` EXPLICITLY - and an explicit grant to a role is not removed
-- by `REVOKE ALL ... FROM PUBLIC`, which only drops the PUBLIC grant.
--
-- So the migration's REVOKE/GRANT block read as a lock and was not one.
-- Measured on production at 03:07 UTC, before this migration:
--
--   fn_ca_escalate_reconcile_criticals  {postgres,anon,authenticated,service_role}
--   fn_ca_remeasure_entity              {postgres,anon,authenticated,service_role}
--   fn_ca_treasury_positions            {postgres,authenticated,service_role}
--
-- Before 20260921023309 the escalator held exactly {postgres, service_role}.
-- The widening was introduced by that migration and is the defect this one
-- closes. `reconcile_ledger_nightly` was only ever CREATE OR REPLACE'd, which
-- preserves the ACL, and is still {postgres, service_role} - untouched here.
--
-- WHY IT MATTERS. All three are SECURITY DEFINER, so they run as the owner,
-- past RLS, and none of them asks who is calling:
--
--   * fn_ca_escalate_reconcile_criticals is VOLATILE and WRITES - it files
--     rows on the incident board. An unauthenticated caller could have driven
--     the board through PostgREST.
--   * fn_ca_remeasure_entity and fn_ca_treasury_positions are read-only, but
--     they return every club's treasury balance and its journal position.
--     READ-ONLY IS NOT HARMLESS: on 2026-08-31 three read-only definers
--     arrived the same way and one of them handed the entire schema to
--     anybody who asked.
--
-- None of the three is an RLS policy helper - pg_policy has no qual or
-- with-check expression naming any of them, checked before revoking - so
-- closing them denies no SELECT anywhere.
--
-- All three are operator and engine telemetry: the reconciler records what
-- fn_ca_treasury_positions measures, and pg_cron job 226 calls the escalator.
-- pg_cron runs as `postgres`, and the engine uses `service_role`. Nothing a
-- browser reaches needs any of them, so this is remedy 1 from
-- scripts/ci/check-definer-authorization: revoke from PUBLIC **and the roles
-- by name**, then grant back only what actually calls them.
--
-- Asserted at the end: anon and authenticated can execute none of the three.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

REVOKE ALL ON FUNCTION public.fn_ca_escalate_reconcile_criticals(interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_escalate_reconcile_criticals(interval)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION public.fn_ca_remeasure_entity(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_remeasure_entity(text, uuid)
  TO postgres, service_role;

REVOKE ALL ON FUNCTION public.fn_ca_treasury_positions()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_treasury_positions()
  TO postgres, service_role;

DO $assert$
DECLARE
  r      record;
  v_bad  text := '';
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_ca_escalate_reconcile_criticals',
                         'fn_ca_remeasure_entity',
                         'fn_ca_treasury_positions')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      v_bad := v_bad || r.proname || ' (anon) ';
    END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      v_bad := v_bad || r.proname || ' (authenticated) ';
    END IF;
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      v_bad := v_bad || r.proname || ' (service_role LOST ITS GRANT) ';
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION 'definer authorization not closed: %', v_bad;
  END IF;

  RAISE NOTICE 'all three definers are closed to anon and authenticated, service_role retained';
END;
$assert$;

COMMIT;
