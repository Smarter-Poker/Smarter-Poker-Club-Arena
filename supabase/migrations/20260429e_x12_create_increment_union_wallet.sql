-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 10 — increment_union_wallet RPC
--
-- After Round 9 created 4 of 9 missing RPCs, Round 10 triaged the remaining 5
-- against actual production data state:
--
--   bulk_add_vip_points              → DEFER (vip_progress table doesn't exist;
--                                            caller has add_vip_points fallback)
--   bulk_update_position_stats       → DEFER (position_stats table doesn't exist;
--                                            analytics-only, no money flow)
--   increment_promotion_claim_count  → DEFER (promotion_claims table doesn't exist;
--                                            parent INSERT fails before RPC call)
--   redeem_referral_code             → DEFER (referral_codes table doesn't exist;
--                                            UI must hide referral input at relaunch)
--   increment_union_wallet           → BUILD ✓  (1 union × 2 member clubs in prod;
--                                                active rake-collection money path)
--
-- Without this RPC, every rake-collection event from clubs in unions silently
-- 404s. The caller (server/src/services/supabase.ts logRakeCollection) logs an
-- error but does NOT transactionally back out, so rake gets recorded in
-- club_wallets while union_wallets stays at zero → settlement chain divergence.
-- (Production rake_wallet was 0.00 against chip_balance of 11002.97 — exactly
-- this divergence pattern.)
--
-- Atomic increment via UPDATE eliminates the read-then-write race that the
-- legacy code path had (see FIX-232 in caller comment).
--
-- Applied to production via Supabase MCP migration
-- x12_create_increment_union_wallet_2026_04_29.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.increment_union_wallet(
  p_union_id uuid, p_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_new_chip numeric;
  v_new_rake numeric;
BEGIN
  IF p_union_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_union_id required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount');
  END IF;

  -- Upsert (in case the union_wallets row was never seeded).
  INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
       VALUES (p_union_id, p_amount, p_amount, p_amount)
  ON CONFLICT (union_id) DO UPDATE SET
       chip_balance         = public.union_wallets.chip_balance + p_amount,
       rake_wallet          = public.union_wallets.rake_wallet + p_amount,
       total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_amount,
       updated_at           = NOW()
  RETURNING chip_balance, rake_wallet INTO v_new_chip, v_new_rake;

  RETURN jsonb_build_object(
    'success', true,
    'union_id', p_union_id,
    'amount', p_amount,
    'new_chip_balance', v_new_chip,
    'new_rake_wallet',  v_new_rake
  );
END $function$;

REVOKE EXECUTE ON FUNCTION public.increment_union_wallet(uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_union_wallet(uuid, numeric) TO service_role;
