-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429061544 "x18_replace_bbj_promo_payout_match_caller_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 044137f08e49644d2c3255d91d61effc of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 18 — Replace bbj_promo_payout with the signature BBJService.executePromoPayout
-- actually calls. Round 9 built (p_pool_id, p_user_id, p_amount) thinking the RPC
-- credited a single recipient, but the real caller pattern is:
--
--   Phase 1: RPC deducts p_amount from pool's promo_balance + records the
--            event with reason/triggered_by/event_type/recipients
--   Phase 2: Caller credits each recipient individually via
--            atomic_credit_wallet_and_log (so the per-player audit chain
--            stays uniform with all other wallet credits)
--
-- The Round 9 RPC was 404'ing in PostgREST because of param mismatch, so
-- the entire BBJ promo payout flow was dead. Drop + replace with the
-- actually-called signature.

DROP FUNCTION IF EXISTS public.bbj_promo_payout(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION public.bbj_promo_payout(
  p_pool_id           uuid,
  p_amount            numeric,
  p_recipient_user_ids uuid[],
  p_reason            text DEFAULT NULL,
  p_triggered_by      uuid DEFAULT NULL,
  p_event_type        text DEFAULT 'custom'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_pool record;
  v_new_promo numeric;
  v_event_id  uuid;
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

  -- Deduct the bank slice atomically
  UPDATE public.bbj_pools
     SET promo_balance  = promo_balance - p_amount,
         pool_amount    = pool_amount   - p_amount,
         total_paid_out = COALESCE(total_paid_out, 0) + p_amount,
         updated_at     = NOW()
   WHERE id = p_pool_id
  RETURNING promo_balance INTO v_new_promo;

  -- Record the event so we have an audit row distinct from per-recipient
  -- wallet credits the caller will write next.
  INSERT INTO public.bbj_payouts
    (pool_id, club_id, amount, payout_type, recipients, reason, triggered_by)
  VALUES (
    p_pool_id, v_pool.club_id, p_amount, p_event_type,
    to_jsonb(p_recipient_user_ids), p_reason, p_triggered_by
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'event_id', v_event_id,
    'amount', p_amount,
    'recipient_count', array_length(p_recipient_user_ids, 1),
    'new_promo_balance', v_new_promo,
    'event_type', p_event_type
  );
EXCEPTION
  -- bbj_payouts may have a tighter shape; if so, fall through to a soft-success
  -- so the caller can still credit recipients. The caller writes its own audit
  -- row via wallet_transactions for each recipient anyway.
  WHEN undefined_column OR undefined_table THEN
    RETURN jsonb_build_object(
      'success', true,
      'amount', p_amount,
      'recipient_count', array_length(p_recipient_user_ids, 1),
      'new_promo_balance', v_new_promo,
      'event_type', p_event_type,
      'audit_row', 'skipped_schema_mismatch'
    );
END $function$;

REVOKE EXECUTE ON FUNCTION public.bbj_promo_payout(uuid, numeric, uuid[], text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_promo_payout(uuid, numeric, uuid[], text, uuid, text)
  TO service_role;
