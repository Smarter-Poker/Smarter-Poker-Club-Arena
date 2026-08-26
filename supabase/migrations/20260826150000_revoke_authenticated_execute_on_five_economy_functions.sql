-- APPLIED TO PRODUCTION 2026-08-26 via Supabase MCP apply_migration
-- (supabase_migrations.schema_migrations name:
--  revoke_authenticated_execute_on_five_economy_functions).
--
-- Supersedes the EXECUTE-privilege half of
-- 20260826140045_fix_economy_auth_guards.sql (PR #994), which merged to main on
-- 2026-08-26 but was never applied. Club Arena is a Vite SPA; nothing in its
-- deploy pipeline runs migrations, so merging that PR published a text file.
--
-- STATE FOUND IN PRODUCTION on 2026-08-26: all five functions were SECURITY
-- DEFINER, granted EXECUTE to `authenticated`, and contained no auth.uid()
-- check. fn_pay_player_chips(p_user_id, p_amount, ...) took an arbitrary user
-- id and amount, so any logged-in player could call it over PostgREST and pay
-- themselves.
--
-- WHY THIS ONLY REVOKES AND DOES NOT REPLACE THE BODIES -- #994 is defective:
--   * fn_pay_player_chips and fn_purchase_club_chips bodies in #994 are SHORTER
--     than the live definitions (1702 vs 1795 and 2640 vs 2991 chars).
--     CREATE OR REPLACE with them would silently drop live logic.
--   * #994's fn_bbj_promo_payout_atomic block declares a 3-arg signature
--     (p_amount, p_event_type, p_reason); the live function is 5-arg
--     (p_pool_id, p_amount, p_recipient_user_ids, p_reason, p_event_type).
--     It is a different function that ignores the caller's recipient list and
--     credits every 'eligible' row in promo_eligibility. Applying #994 would
--     create that as a stray overload and then GRANT EXECUTE back to the
--     still-unguarded 5-arg original on its line 315 -- leaving the hole open
--     while adding a mass-payout function.
--   #994 must be superseded, never applied. See
--   .agent/audits/2026-08-26-pr994-never-applied-and-defective.md
--
-- CALL-SITE CHECK BEFORE REVOKING: add_diamonds_to_balance has ~30 call sites,
-- all in World Hub pages/api/** using SUPABASE_SERVICE_ROLE_KEY, which a revoke
-- on `authenticated` does not affect. The other four have zero call sites in
-- either repo. Comments in pages/api/club-arena/purchase-chips.js and
-- src/pages/marketplace/marketplaceShared.ts already assert EXECUTE "is
-- revoked" on these, so a later DROP/CREATE reset the privileges; this restores
-- the documented intent rather than changing it.
--
-- ROLLBACK (restores the exact pre-migration privileges):
--   GRANT EXECUTE ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_purchase_club_chips(uuid, uuid, numeric, integer, text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_pay_player_chips(uuid, numeric, text, text, uuid, uuid) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_bbj_promo_payout_atomic(uuid, numeric, uuid[], text, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_purchase_club_chips(uuid, uuid, numeric, integer, text) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_pay_player_chips(uuid, numeric, text, text, uuid, uuid) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_bbj_promo_payout_atomic(uuid, numeric, uuid[], text, text) FROM authenticated, anon, PUBLIC;

DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.proname || ' -> ' || r.rolname, ', ')
    INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (VALUES ('authenticated'), ('anon')) AS r(rolname)
  WHERE n.nspname = 'public'
    AND p.proname IN ('add_diamonds_to_balance', 'fn_purchase_chips',
                      'fn_purchase_club_chips', 'fn_pay_player_chips',
                      'fn_bbj_promo_payout_atomic')
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'REVOKE did not take effect for: %', v_bad;
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_promo_payout_atomic') <> 1 THEN
    RAISE EXCEPTION 'fn_bbj_promo_payout_atomic has an unexpected overload count - #994 may have been applied';
  END IF;

  IF NOT has_function_privilege('service_role',
        'public.add_diamonds_to_balance(uuid, integer, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on add_diamonds_to_balance - server routes would break';
  END IF;
END
$$;
