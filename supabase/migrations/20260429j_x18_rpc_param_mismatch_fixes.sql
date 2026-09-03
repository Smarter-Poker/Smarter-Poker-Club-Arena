-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 18 — RPC parameter signature mismatch sweep.
--
-- Supabase dispatches RPC calls by parameter NAMES. Mismatched names
-- silently 404 in PostgREST — same failure mode as the phantom RPCs we
-- caught in Rounds 2 / 9 but harder to spot because the function exists
-- and tests against direct SQL pass.
--
-- Methodology:
--   1. Parse every supabase.rpc('name', { keys }) call across club-arena
--      src/services + src/pages + server/src
--   2. Pull every matching pg_proc.proargnames in production
--   3. Cross-check: caller key set must be a subset of (one of) the
--      function's overload arg sets
--
-- 102 callers checked, 23 mismatches found. Highest-priority fixes
-- landed here:
--
--   bbj_promo_payout — Round 9 RPC built (p_pool_id, p_user_id, p_amount)
--   but BBJService.executePromoPayout calls
--     (p_pool_id, p_amount, p_recipient_user_ids, p_reason,
--      p_triggered_by, p_event_type)
--   The Round 9 signature was rebuilt without per-recipient credit
--   (caller writes per-recipient wallet_transactions in Phase 2).
--   Replaced by x18 + simplified by x18b.
--
-- 22 other mismatches ledgered for follow-up rounds (mostly admin /
-- moderator / VIP / referral surfaces that aren't relaunch-blocking).
-- The 5 cashout-pipeline callers got fixed FE-side in src/services/
-- CashoutService.ts because the production sigs are the source of truth:
--   fn_agent_approve_cashout  p_agent_id+p_note    → p_agent_user_id+p_agent_note
--   fn_cancel_cashout         p_player_id          → p_user_id
--   fn_complete_cashout       p_agent_id           → p_completed_by
--   fn_reject_cashout         p_note               → p_reason
--   fn_expire_stale_cashouts  p_max_hours          → p_ttl_hours
--
-- Applied to production via Supabase MCP migrations
--   x18_replace_bbj_promo_payout_match_caller_2026_04_29
--   x18b_simplify_bbj_promo_payout_2026_04_29
-- ═══════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.bbj_promo_payout(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION public.bbj_promo_payout(
  p_pool_id            uuid,
  p_amount             numeric,
  p_recipient_user_ids uuid[],
  p_reason             text DEFAULT NULL,
  p_triggered_by       uuid DEFAULT NULL,
  p_event_type         text DEFAULT 'custom'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_pool record;
  v_new_promo numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount');
  END IF;
  IF p_recipient_user_ids IS NULL OR array_length(p_recipient_user_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_recipients');
  END IF;

  SELECT * INTO v_pool FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_pool.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'pool_not_found');
  END IF;
  IF COALESCE(v_pool.promo_balance, 0) < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient_promo_balance',
      'available', v_pool.promo_balance, 'requested', p_amount
    );
  END IF;

  UPDATE public.bbj_pools
     SET promo_balance  = promo_balance - p_amount,
         pool_amount    = pool_amount   - p_amount,
         total_paid_out = COALESCE(total_paid_out, 0) + p_amount,
         updated_at     = NOW()
   WHERE id = p_pool_id
  RETURNING promo_balance INTO v_new_promo;

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'recipient_count', array_length(p_recipient_user_ids, 1),
    'new_promo_balance', v_new_promo,
    'event_type', p_event_type,
    'reason', p_reason,
    'triggered_by', p_triggered_by
  );
END $function$;

REVOKE EXECUTE ON FUNCTION public.bbj_promo_payout(uuid, numeric, uuid[], text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_promo_payout(uuid, numeric, uuid[], text, uuid, text)
  TO service_role;
