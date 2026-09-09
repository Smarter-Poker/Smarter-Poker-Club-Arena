-- Repository production refund definition, isolated test only.
CREATE TABLE diamond_purchases(id uuid PRIMARY KEY,user_id uuid,status text,refunded_amount_cents integer DEFAULT 0,
 refunded_diamonds integer DEFAULT 0,diamonds_amount integer,bonus_diamonds integer DEFAULT 0,
 metadata jsonb DEFAULT '{}'::jsonb,updated_at timestamptz,refunded_at timestamptz);
ALTER TABLE profiles ADD COLUMN vip_tier text,ADD COLUMN vip_expires_at timestamptz,ADD COLUMN is_vip boolean DEFAULT false;
CREATE OR REPLACE FUNCTION public.fn_diamond_purchase_refund(p_purchase_id uuid, p_charge_amount_cents integer, p_refunded_amount_cents integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $function$
DECLARE
  v_purchase public.diamond_purchases%ROWTYPE; v_profile public.profiles%ROWTYPE;
  v_total integer; v_cumulative integer; v_target integer; v_delta integer; v_full boolean;
  v_intent jsonb; v_redemption jsonb; v_unwind jsonb; v_wallet jsonb;
  v_unwind_state text := 'not_requested'; v_balance integer; v_daily_cost integer := 150;
  v_available integer; v_applied integer := 0; v_shortfall integer := 0;
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

  IF v_purchase.status = 'refunded'
     AND COALESCE((v_purchase.metadata ->> 'refund_before_settlement')::boolean, false) THEN
    UPDATE public.diamond_purchases SET refunded_amount_cents = v_cumulative, updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'fully_refunded', true,
      'terminal_refund', true, 'refunded_diamonds', 0,
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0) FROM public.profiles WHERE id = v_purchase.user_id));
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
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0) FROM public.profiles WHERE id = v_purchase.user_id));
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
      v_unwind_state := CASE WHEN COALESCE((v_unwind ->> 'success')::boolean, false) THEN 'revoked' ELSE 'debt_recorded' END;
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
    SELECT COALESCE(diamonds, diamond_balance, 0) INTO v_available FROM public.profiles WHERE id = v_purchase.user_id;
    v_available := GREATEST(COALESCE(v_available, 0), 0);
    v_applied := LEAST(v_delta, v_available);
    v_shortfall := v_delta - v_applied;

    IF v_applied > 0 THEN
      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, diamond_balance, 0) - v_applied,
             diamond_balance = COALESCE(diamonds, diamond_balance, 0) - v_applied, updated_at = now()
       WHERE id = v_purchase.user_id RETURNING diamonds INTO v_balance;
    ELSE
      v_balance := v_available;
    END IF;

    IF v_shortfall > 0 THEN
      INSERT INTO public.diamond_debts (user_id, purchase_id, amount, reason)
      VALUES (v_purchase.user_id, v_purchase.id, v_shortfall, 'chargeback_exceeds_balance');
      BEGIN
        PERFORM public.fn_ca_diamond_incident('DR1:chargeback_exceeds_balance', 'critical', v_purchase.user_id, v_shortfall,
          'fn_diamond_purchase_refund',
          jsonb_build_object('purchase_id', v_purchase.id, 'reversal_owed', v_delta, 'balance_applied', v_applied,
                             'debt_booked', v_shortfall, 'balance_after', v_balance));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;

    INSERT INTO public.diamond_transactions(user_id,type,amount,balance_after,description,
      reference_id,transaction_type,source,metadata,counterparty,issuance_class)
    VALUES (v_purchase.user_id,'refund',-v_applied,v_balance,'Stripe refund',
      'diamond-refund:' || v_purchase.id::text || ':' || v_target,'refund','stripe',
      jsonb_build_object('purchase_id',v_purchase.id,'chargeback_debt',v_shortfall > 0,
        'reversal_owed',v_delta,'balance_applied',v_applied,'debt_booked',v_shortfall),
      'purchase_clearing','refund');

    -- DR9: the lot carries what was reversed. A failure here is loud (review R2-13), never fatal.
    BEGIN
      UPDATE public.diamond_purchase_lots
         SET refunded = LEAST(issued - consumed, GREATEST(refunded, v_target))
       WHERE purchase_id = v_purchase.id;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.fn_ca_diamond_incident('DR9:purchase_lot_write_failed', 'critical', v_purchase.user_id, v_target,
          'fn_diamond_purchase_refund',
          jsonb_build_object('purchase_id', v_purchase.id, 'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'target', v_target));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END;
  ELSE
    SELECT COALESCE(diamonds, diamond_balance, 0) INTO v_balance FROM public.profiles WHERE id = v_purchase.user_id;
  END IF;
  UPDATE public.diamond_purchases
     SET refunded_amount_cents = v_cumulative, refunded_diamonds = v_target,
         refunded_at = CASE WHEN v_full THEN COALESCE(refunded_at,now()) ELSE refunded_at END,
         status = CASE WHEN v_full THEN 'refunded' ELSE status END,
         metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
           'redemption_refund_status',v_unwind_state,'refund_balance_after',v_balance,
           'chargeback_debt',v_shortfall > 0,'chargeback_debt_amount',v_shortfall,
           'refunded_diamonds',v_target), updated_at=now()
   WHERE id=v_purchase.id;
  RETURN jsonb_build_object('success',true,'fully_refunded',v_full,'refunded_diamonds',v_target,
    'new_balance',v_balance,'redemption_refund_status',v_unwind_state,
    'chargeback_debt',v_shortfall > 0,'chargeback_debt_amount',v_shortfall,'balance_applied',v_applied);
END;
$function$;
