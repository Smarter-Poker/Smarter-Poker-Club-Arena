-- ═══════════════════════════════════════════════════════════════════════════
-- calculate_cascading_commission IS NOT A BROWSER RPC
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED (read-only session; see the pull request). GRANT/REVOKE does not
-- fire pgrst_ddl_watch, so applying this file causes no PostgREST schema
-- reload and none of the risk CLAUDE.md's DDL policy is about.
--
-- STATE FOUND IN PRODUCTION 2026-09-01:
--
--     calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)
--     prosecdef = false
--     proacl    = {=X/postgres, postgres=X/postgres, anon=X/postgres,
--                  authenticated=X/postgres, service_role=X/postgres}
--
-- so PUBLIC, anon and authenticated all hold EXECUTE on a function that
-- INSERTs into agent_commissions, INSERTs the club-owner residual, and UPDATEs
-- club_wallets.period_commission_paid and lifetime_commission_paid.
--
-- HOW BAD IT IS, STATED HONESTLY RATHER THAN DRAMATICALLY. It is not currently
-- exploitable, for one reason: the function is SECURITY INVOKER, so its writes
-- run as the caller and RLS stands behind them. agent_commissions admits
-- writes only through `agent_commissions_service_only` (auth.role() =
-- 'service_role'); authenticated has two READ policies and nothing else.
-- club_wallets is the same shape. A logged-in caller therefore gets an RLS
-- refusal, not a commission.
--
-- IT IS STILL WRONG, AND IT IS THE KIND OF WRONG THAT STOPS BEING SAFE
-- QUIETLY. The only thing between an anonymous caller and a writable agent
-- ledger is two RLS policies that nothing ties to this grant. A future
-- `FOR ALL ... USING (true)` written for some unrelated admin surface -- the
-- most ordinary policy edit there is -- turns a dormant grant into a live
-- money path, and nobody editing that policy would think to look here. The
-- house rule is that a function which writes money is reachable by
-- service_role and no one else, and this one predates the rule.
--
-- CALL SITES CHECKED BEFORE REVOKING.
--
--   * World Hub pages/api/club-arena/record-rake.js and settle-period.js call
--     it with SUPABASE_SERVICE_ROLE_KEY. Unaffected: service_role keeps
--     EXECUTE.
--   * Club Arena src/services/CommissionService.ts:292 calls it from the
--     browser client -- and that call has never worked. It passes
--     { p_rake_amount, p_player_id }; the function's parameters are
--     p_hand_id, p_club_id, p_player_user_id, p_rake_amount, p_rake_record_id,
--     p_table_id. There is no p_player_id, so PostgREST cannot resolve the
--     overload and the call 404s before it reaches Postgres. Nothing in src/
--     or tests/ calls the method either -- it is dead code that names a live
--     money function, which is exactly how a grant like this survives a
--     review. It is left in place here rather than deleted: this migration
--     changes privileges only, and removing it is a source change that belongs
--     in its own commit.
--
-- FOLLOWS 20260826150000_revoke_authenticated_execute_on_five_economy_functions:
-- revoke per role (a REVOKE FROM PUBLIC alone does NOT close a function that
-- also carries an explicit grant to authenticated), then assert the revoke
-- took and that service_role did not lose the grant the server routes need.
--
-- ROLLBACK (restores the exact pre-migration privileges):
--   GRANT EXECUTE ON FUNCTION public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid, uuid) TO anon, authenticated, PUBLIC;

BEGIN;

REVOKE EXECUTE ON FUNCTION public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid, uuid)
  FROM authenticated, anon, PUBLIC;

DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(r.rolname, ', ')
    INTO v_bad
  FROM (VALUES ('authenticated'), ('anon')) AS r(rolname)
  WHERE has_function_privilege(
          r.rolname,
          'public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid, uuid)',
          'EXECUTE');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'REVOKE did not take effect for: %', v_bad;
  END IF;

  IF NOT has_function_privilege('service_role',
        'public.calculate_cascading_commission(uuid, uuid, uuid, numeric, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on calculate_cascading_commission - record-rake and settle-period would break';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'calculate_cascading_commission') <> 1 THEN
    RAISE EXCEPTION 'calculate_cascading_commission has an unexpected overload count - the revoke may have named the wrong signature';
  END IF;
END
$$;

COMMIT;
