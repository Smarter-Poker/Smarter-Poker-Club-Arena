-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830130000; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Commerce replay guards discovered during the final adversarial release pass.
-- This follow-up migration is required because the preceding functions were
-- already deployed before the replay sequences were exercised.
BEGIN
CREATE OR REPLACE FUNCTION public.settle_diamond_card_purchase_atomic(
  p_purchase_id uuid, p_session_id text, p_payment_intent_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $function$
DECLARE
  v_purchase public.diamond_purchases%ROWTYPE; v_credit jsonb; v_redemption jsonb;
  v_intent jsonb; v_total integer; v_new_balance integer; v_kind text;
BEGIN
  SELECT * INTO v_purchase FROM public.diamond_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;

  IF v_purchase.status = 'completed' THEN
    IF v_purchase.stripe_checkout_session_id IS DISTINCT FROM p_session_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'settlement_conflict');
    END IF;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'purchase_id', v_purchase.id,
      'redemption_status', v_purchase.metadata ->> 'redemption_status');
  END IF;

  -- A charge fully refunded before checkout.completed never credited this
  -- package. Acknowledge the later event as terminal success, bind its Stripe
  -- identities, and never call the wallet credit path.
  IF v_purchase.status = 'refunded'
     AND COALESCE((v_purchase.metadata ->> 'refund_before_settlement')::boolean, false) THEN
    IF v_purchase.stripe_checkout_session_id IS NOT NULL
       AND v_purchase.stripe_checkout_session_id IS DISTINCT FROM p_session_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'settlement_conflict');
    END IF;
    IF v_purchase.stripe_payment_intent_id IS NOT NULL
       AND v_purchase.stripe_payment_intent_id IS DISTINCT FROM p_payment_intent_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'settlement_conflict');
    END IF;
    UPDATE public.diamond_purchases
       SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, p_session_id),
           stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, p_payment_intent_id),
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('terminal_settlement_acknowledged_at', now()),
           updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'terminal_refund', true,
      'purchase_id', v_purchase.id, 'redemption_status', 'not_requested');
  END IF;
  IF v_purchase.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_pending');
  END IF;

  v_total := COALESCE(v_purchase.diamonds_amount, 0) + COALESCE(v_purchase.bonus_diamonds, 0);
  v_credit := public.add_diamonds_to_balance(v_purchase.user_id, v_total, 'purchase',
    'Purchased ' || COALESCE(v_purchase.package_name, 'Diamond package') || ' (' || v_total || ' diamonds)',
    v_purchase.id::text);
  IF COALESCE((v_credit ->> 'success')::boolean, false) IS NOT TRUE
     AND COALESCE((v_credit ->> 'duplicate')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'diamond_credit_failed:%', COALESCE(v_credit ->> 'error', 'unknown');
  END IF;

  v_intent := COALESCE(v_purchase.metadata -> 'redemption_intent', '{}'::jsonb);
  v_kind := v_intent ->> 'kind';
  IF v_kind = 'club_shop' THEN
    v_redemption := public.fn_purchase_club_shop_item_diamonds(
      (v_intent ->> 'club_id')::uuid, v_purchase.user_id, (v_intent ->> 'item_id')::uuid,
      'card-redemption:' || v_purchase.id::text);
  ELSIF v_kind = 'vip_daily' THEN
    v_redemption := public.purchase_vip_with_diamonds_atomic_v2(
      v_purchase.user_id, 150, 1, 'daily', 'card-redemption:' || v_purchase.id::text,
      'VIP Daily Pass (Card Funded)');
  ELSE
    v_redemption := jsonb_build_object('success', true, 'skipped', true);
  END IF;

  SELECT COALESCE(diamonds, 0) INTO v_new_balance FROM public.profiles WHERE id = v_purchase.user_id;
  UPDATE public.diamond_purchases
     SET status = 'completed', stripe_checkout_session_id = p_session_id,
         stripe_payment_intent_id = p_payment_intent_id, completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'redemption_status', CASE WHEN v_kind IS NULL THEN 'not_requested'
             WHEN COALESCE((v_redemption ->> 'success')::boolean, false) THEN 'completed'
             ELSE 'needs_review' END,
           'redemption_error', CASE WHEN COALESCE((v_redemption ->> 'success')::boolean, false)
             THEN NULL ELSE v_redemption ->> 'error' END,
           'redemption_result', v_redemption, 'settled_at', now())
   WHERE id = v_purchase.id;
  RETURN jsonb_build_object('success', true, 'duplicate', false, 'purchase_id', v_purchase.id,
    'new_balance', v_new_balance,
    'redemption_status', CASE WHEN v_kind IS NULL THEN 'not_requested'
      WHEN COALESCE((v_redemption ->> 'success')::boolean, false) THEN 'completed'
      ELSE 'needs_review' END,
    'redemption', v_redemption);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_card_merch_refund_atomic(
  p_order_id uuid, p_charge_amount_cents integer, p_refunded_amount_cents integer,
  p_metadata_patch jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $function$
DECLARE
  v_order public.merchandise_orders%ROWTYPE; v_target integer; v_full boolean;
  v_lines jsonb; v_release jsonb; v_restore boolean; v_metadata jsonb;
BEGIN
  IF p_charge_amount_cents IS NULL OR p_charge_amount_cents <= 0
     OR p_refunded_amount_cents IS NULL OR p_refunded_amount_cents < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_refund_amount');
  END IF;
  SELECT * INTO v_order FROM public.merchandise_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'order_not_found'); END IF;
  v_target := GREATEST(COALESCE(v_order.refunded_amount_cents, 0),
    LEAST(p_charge_amount_cents, p_refunded_amount_cents));
  v_full := v_target >= p_charge_amount_cents;
  v_restore := COALESCE(v_order.stock_restored, false);

  -- Restock only orders proven never to have entered carrier fulfillment.
  -- The pending-return marker and shipping timestamps survive status='refunded'
  -- and therefore keep duplicate refund events from releasing stock.
  IF v_full
     AND v_order.status IN ('pending', 'processing', 'paid', 'completed', 'canceled', 'cancelled', 'failed', 'refunded')
     AND COALESCE((v_order.metadata ->> 'stock_restore_pending_return')::boolean, false) IS NOT TRUE
     AND v_order.shipped_at IS NULL AND v_order.delivered_at IS NULL
     AND COALESCE(v_order.metadata ->> 'fulfillment_status', '') NOT IN ('shipped', 'delivered')
     AND COALESCE((v_order.metadata ->> 'stock_reserved')::boolean, false) AND NOT v_restore THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', COALESCE(line ->> 'id', line ->> 'catalogId'),
      'variant_id', COALESCE(line ->> 'variantId', line ->> 'variant_id'),
      'qty', LEAST(GREATEST(COALESCE((line ->> 'quantity')::integer, 1), 1), 10)
    )), '[]'::jsonb) INTO v_lines
      FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) line
     WHERE COALESCE((line ->> 'madeToOrder')::boolean, false) IS NOT TRUE;
    IF jsonb_array_length(v_lines) > 0 THEN
      v_release := public.release_merch_order(v_lines);
      IF COALESCE((v_release ->> 'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'stock_release_failed:%', COALESCE(v_release ->> 'error', 'unknown');
      END IF;
    END IF;
    v_restore := true;
  END IF;

  v_metadata := COALESCE(v_order.metadata, '{}'::jsonb) || COALESCE(p_metadata_patch, '{}'::jsonb)
    || jsonb_build_object('refund_status', CASE WHEN v_full THEN 'full' ELSE 'partial' END,
      'refunded_amount_cents', v_target, 'stock_restored', v_restore);
  IF v_full AND (
       v_order.status IN ('shipped', 'delivered') OR v_order.shipped_at IS NOT NULL
       OR v_order.delivered_at IS NOT NULL
       OR COALESCE(v_order.metadata ->> 'fulfillment_status', '') IN ('shipped', 'delivered')
       OR COALESCE((v_order.metadata ->> 'stock_restore_pending_return')::boolean, false)
     ) AND NOT v_restore THEN
    v_metadata := v_metadata || jsonb_build_object('needs_review', true,
      'reason', 'return_required_before_stock_restore', 'stock_restore_pending_return', true);
  END IF;
  UPDATE public.merchandise_orders
     SET refunded_amount_cents = v_target,
         status = CASE WHEN v_full THEN 'refunded' ELSE status END,
         stock_restored = v_restore, metadata = v_metadata, updated_at = now()
   WHERE id = v_order.id;
  RETURN jsonb_build_object('success', true, 'order_id', v_order.id, 'fully_refunded', v_full,
    'stock_restored', v_restore, 'refunded_amount_cents', v_target);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_diamond_purchase_refund(
  p_purchase_id uuid, p_charge_amount_cents integer, p_refunded_amount_cents integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $function$
DECLARE
  v_purchase public.diamond_purchases%ROWTYPE; v_profile public.profiles%ROWTYPE;
  v_total integer; v_cumulative integer; v_target integer; v_delta integer; v_full boolean;
  v_intent jsonb; v_redemption jsonb; v_unwind jsonb; v_wallet jsonb;
  v_unwind_state text := 'not_requested'; v_balance integer; v_daily_cost integer := 150;
BEGIN
  IF p_charge_amount_cents IS NULL OR p_charge_amount_cents <= 0
     OR p_refunded_amount_cents IS NULL OR p_refunded_amount_cents < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_refund_amount');
  END IF;
  SELECT * INTO v_purchase FROM public.diamond_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;
  v_cumulative := GREATEST(COALESCE(v_purchase.refunded_amount_cents, 0),
    LEAST(p_charge_amount_cents, p_refunded_amount_cents));
  v_full := v_cumulative >= p_charge_amount_cents;

  -- This package never credited a wallet. Every refund replay is a successful
  -- zero-delta terminal event, even if events arrive out of order.
  IF v_purchase.status = 'refunded'
     AND COALESCE((v_purchase.metadata ->> 'refund_before_settlement')::boolean, false) THEN
    UPDATE public.diamond_purchases SET refunded_amount_cents = v_cumulative, updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'fully_refunded', true,
      'terminal_refund', true, 'refunded_diamonds', 0,
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0)
                        FROM public.profiles WHERE id = v_purchase.user_id));
  END IF;
  IF v_purchase.status = 'pending' THEN
    IF NOT v_full THEN RETURN jsonb_build_object('success', false, 'error', 'settlement_pending'); END IF;
    UPDATE public.diamond_purchases
       SET status = 'refunded', refunded_amount_cents = v_cumulative, refunded_diamonds = 0,
           refunded_at = COALESCE(refunded_at, now()),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('refund_before_settlement', true),
           updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'fully_refunded', true, 'terminal_refund', true,
      'refunded_diamonds', 0,
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0)
                        FROM public.profiles WHERE id = v_purchase.user_id));
  END IF;
  IF v_purchase.status NOT IN ('completed', 'refunded') THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_settled');
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_purchase.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'profile_not_found'); END IF;
  v_total := COALESCE(v_purchase.diamonds_amount, 0) + COALESCE(v_purchase.bonus_diamonds, 0);
  v_target := GREATEST(COALESCE(v_purchase.refunded_diamonds, 0),
    LEAST(v_total, round(v_total::numeric * v_cumulative / p_charge_amount_cents)::integer));
  v_delta := GREATEST(0, v_target - COALESCE(v_purchase.refunded_diamonds, 0));
  v_intent := COALESCE(v_purchase.metadata -> 'redemption_intent', '{}'::jsonb);
  v_redemption := COALESCE(v_purchase.metadata -> 'redemption_result', '{}'::jsonb);
  IF v_full AND COALESCE(v_purchase.metadata ->> 'redemption_status', '') = 'completed'
     AND COALESCE(v_purchase.metadata ->> 'redemption_refund_status', '') NOT IN ('revoked', 'debt_recorded') THEN
    IF v_intent ->> 'kind' = 'club_shop' AND v_redemption ? 'purchase_id' THEN
      v_unwind := public.fn_refund_shop_purchase((v_intent ->> 'club_id')::uuid,
        (v_redemption ->> 'purchase_id')::uuid, v_purchase.user_id,
        'Card-funded Club Shop purchase reversed by Stripe refund');
      v_unwind_state := CASE WHEN COALESCE((v_unwind ->> 'success')::boolean, false)
        THEN 'revoked' ELSE 'debt_recorded' END;
    ELSIF v_intent ->> 'kind' = 'vip_daily' THEN
      IF v_profile.vip_tier = 'daily' AND v_profile.vip_expires_at IS NOT NULL
         AND v_redemption ? 'expires_at'
         AND abs(extract(epoch FROM (v_profile.vip_expires_at - (v_redemption ->> 'expires_at')::timestamptz))) < 2 THEN
        UPDATE public.profiles SET vip_expires_at = GREATEST(now(), vip_expires_at - interval '1 day'),
          is_vip = (vip_expires_at - interval '1 day') > now(), updated_at = now()
         WHERE id = v_purchase.user_id;
        v_wallet := public.add_diamonds_to_balance(v_purchase.user_id, v_daily_cost, 'refund',
          'Reversed card-funded VIP Daily Pass', 'card-redemption-refund:' || v_purchase.id::text);
        IF COALESCE((v_wallet ->> 'success')::boolean, false) IS NOT TRUE
           AND COALESCE((v_wallet ->> 'duplicate')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'daily_redemption_refund_failed:%', COALESCE(v_wallet ->> 'error', 'unknown');
        END IF;
        v_unwind_state := 'revoked';
      ELSE v_unwind_state := 'debt_recorded'; END IF;
    END IF;
  END IF;
  IF v_delta > 0 THEN
    UPDATE public.profiles
       SET diamonds = COALESCE(diamonds, diamond_balance, 0) - v_delta,
           diamond_balance = COALESCE(diamonds, diamond_balance, 0) - v_delta, updated_at = now()
     WHERE id = v_purchase.user_id RETURNING diamonds INTO v_balance;
    INSERT INTO public.diamond_transactions(user_id,type,amount,balance_after,description,
      reference_id,transaction_type,source,metadata)
    VALUES (v_purchase.user_id,'refund',-v_delta,v_balance,'Stripe refund reconciliation',
      'diamond-refund:' || v_purchase.id::text || ':' || v_target,'refund','stripe',
      jsonb_build_object('purchase_id',v_purchase.id,'chargeback_debt',v_balance < 0));
  ELSE
    SELECT COALESCE(diamonds, diamond_balance, 0) INTO v_balance
      FROM public.profiles WHERE id = v_purchase.user_id;
  END IF;
  UPDATE public.diamond_purchases
     SET refunded_amount_cents = v_cumulative, refunded_diamonds = v_target,
         refunded_at = CASE WHEN v_full THEN COALESCE(refunded_at,now()) ELSE refunded_at END,
         status = CASE WHEN v_full THEN 'refunded' ELSE status END,
         metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
           'redemption_refund_status',v_unwind_state,'refund_balance_after',v_balance,
           'chargeback_debt',v_balance < 0,'refunded_diamonds',v_target), updated_at=now()
   WHERE id=v_purchase.id;
  RETURN jsonb_build_object('success',true,'fully_refunded',v_full,'refunded_diamonds',v_target,
    'new_balance',v_balance,'redemption_refund_status',v_unwind_state,'chargeback_debt',v_balance < 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_diamond_card_purchase_atomic(uuid,text,text),
  public.reconcile_card_merch_refund_atomic(uuid,integer,integer,jsonb),
  public.reconcile_diamond_purchase_refund(uuid,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_diamond_card_purchase_atomic(uuid,text,text),
  public.reconcile_card_merch_refund_atomic(uuid,integer,integer,jsonb),
  public.reconcile_diamond_purchase_refund(uuid,integer,integer) TO service_role;

COMMIT;
