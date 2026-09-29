-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429061626 "x18b_simplify_bbj_promo_payout_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 75d6ae40faf290ebeb40fbdbf1216ed2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 18 cleanup — bbj_payouts schema is for BBJ JACKPOT wins (winner/loser
-- shape), not promo bank distributions to a fan-out of recipients. Drop the
-- event-audit insert from bbj_promo_payout — the caller writes per-recipient
-- wallet_transactions rows in Phase 2 anyway, which collectively provide the
-- audit trail for the payout. Keep the deduction logic, drop the unrelated
-- INSERT. Function still returns the event_id slot but as null.

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
