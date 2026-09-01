-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826144847; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Supersedes the EXECUTE-privilege half of
-- supabase/migrations/20260826140045_fix_economy_auth_guards.sql (PR #994),
-- which was merged to main on 2026-08-26 but never applied. Verified on this
-- date: all five functions were still SECURITY DEFINER, still granted to
-- `authenticated`, and still contained no auth.uid() check, so any logged-in
-- user could call fn_pay_player_chips(<self>, <any amount>, ...) over PostgREST.
--
-- Why this migration only revokes and does not replace the bodies:
--   * fn_pay_player_chips and fn_purchase_club_chips bodies in #994 are SHORTER
--     than the live definitions (1702 vs 1795, 2640 vs 2991 chars). Applying
--     them would silently drop live logic.
--   * #994's fn_bbj_promo_payout_atomic block declares a 3-arg signature
--     (p_amount, p_event_type, p_reason) while the live function is 5-arg
--     (p_pool_id, p_amount, p_recipient_user_ids, p_reason, p_event_type). It
--     would create a stray overload that pays every 'eligible' row in
--     promo_eligibility, then GRANT EXECUTE back to the still-unguarded 5-arg
--     original. #994 must be superseded in the repo, not applied.
--
-- Call-site check before revoking: add_diamonds_to_balance is called ~30 times,
-- all from World Hub pages/api/** using SUPABASE_SERVICE_ROLE_KEY, which a
-- revoke on `authenticated` does not touch. The other four have zero call sites
-- in either repo. Several source comments already assert EXECUTE "is revoked"
-- on these, so a later DROP/CREATE reset the privileges rather than this being
-- a new intent.
--
-- ROLLBACK (restores the pre-migration state exactly):
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
