REVOKE EXECUTE ON FUNCTION public.add_diamonds_to_balance FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_purchase_chips FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_purchase_club_chips FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_pay_player_chips FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_bbj_promo_payout_atomic FROM authenticated;

CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text DEFAULT 'bonus'::text, p_description text DEFAULT NULL::text, p_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_old_balance   integer;
    v_new_balance   integer;
    v_txn_id        uuid;
    v_multiplier    numeric(4,2) := 1.00;
    v_raw_amount    integer := p_amount;
    v_actual_amount integer;
BEGIN
    IF auth.role() = 'authenticated' AND p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    -- LEAK GUARD 2026-08-23: settlement credits MUST carry a reference so the
    -- dedup below can fire. /api/cron/trivia-pvp-cleanup passed NULL and
    -- reminted the same 4 abandoned matches every 4 hours for 10 days
    -- (488 rows, 14,240 diamonds). Refuse rather than mint.
    IF p_reference_id IS NULL
       AND COALESCE(p_amount, 0) > 0
       AND p_type IN ('pvp_refund', 'pvp_win', 'pvp_tie_refund')
    THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', format('reference_id required for settlement type %s', p_type),
            'reference_required', true);
    END IF;

    IF p_reference_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM diamond_transactions WHERE reference_id = p_reference_id AND user_id = p_user_id) THEN
            RETURN jsonb_build_object('success', false, 'error', 'Duplicate reference_id: ' || p_reference_id, 'duplicate', true);
        END IF;
    END IF;

    SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
      INTO v_old_balance, v_multiplier
      FROM profiles WHERE id = p_user_id FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Profile not found');
    END IF;

    IF v_raw_amount > 0
       AND p_type NOT IN (
             'purchase', 'deduction', 'adjustment', 'refund', 'transfer',
             'diamond_gift_received', 'diamond_gift_sent', 'diamond_gift_refund',
             'diamond_received', 'live_gift_received', 'live_gift_sent',
             'vip_daily', 'vip_stipend'
           )
       AND v_multiplier > 1.00
    THEN
        v_actual_amount := ROUND(v_raw_amount * v_multiplier);
    ELSE
        v_actual_amount := v_raw_amount;
    END IF;

    v_new_balance := v_old_balance + v_actual_amount;

    IF v_new_balance < 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Insufficient diamonds');
    END IF;

    UPDATE profiles
       SET diamonds = v_new_balance, diamond_balance = v_new_balance, updated_at = now()
     WHERE id = p_user_id;

    INSERT INTO diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, reference_id, metadata
    ) VALUES (
        p_user_id, v_actual_amount, p_type, p_type,
        CASE WHEN v_actual_amount <> v_raw_amount
             THEN COALESCE(p_description, '') || format(' [%sx boost]', v_multiplier)
             ELSE p_description END,
        v_new_balance, p_reference_id,
        jsonb_build_object('reference_id', p_reference_id, 'raw_amount', v_raw_amount, 'multiplier', v_multiplier)
    ) RETURNING id INTO v_txn_id;

    RETURN jsonb_build_object('success', true, 'old_balance', v_old_balance,
        'new_balance', v_new_balance, 'amount', v_actual_amount,
        'multiplier', v_multiplier, 'transaction_id', v_txn_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_bbj_promo_payout_atomic(p_amount numeric, p_event_type text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_recipients uuid[]; v_uid uuid; v_count int; v_base_cents bigint;
  v_remainder_cents int; v_amt numeric; v_new_bal numeric; v_idx int := 0;
BEGIN
  IF auth.role() = 'authenticated' THEN
      RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT ARRAY(SELECT user_id FROM promo_eligibility WHERE status = 'eligible' AND expires_at > NOW()) INTO v_recipients;
  v_count := array_length(v_recipients, 1);
  IF v_count IS NULL OR v_count = 0 THEN RETURN jsonb_build_object('success', false, 'error', 'no_recipients'); END IF;
  
  v_base_cents := floor((p_amount * 100) / v_count);
  v_remainder_cents := (p_amount * 100) - (v_base_cents * v_count);
  
  FOREACH v_uid IN ARRAY v_recipients LOOP
    v_amt := (v_base_cents + (CASE WHEN v_idx = 0 THEN v_remainder_cents ELSE 0 END))::numeric / 100;
    UPDATE wallets SET balance = balance + v_amt, updated_at = NOW() WHERE user_id = v_uid AND wallet_type = 'PROMO' RETURNING balance INTO v_new_bal;
    IF NOT FOUND THEN
      INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
      VALUES (v_uid, 'PROMO', v_amt, 0, NOW(), NOW()) RETURNING balance INTO v_new_bal; END IF;
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, balance_after)
    VALUES (v_uid, 'PROMO', 'credit', v_amt, 'promotion', 'BBJ promo pool payout', v_new_bal);
    v_idx := v_idx + 1;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'amount', p_amount, 'recipient_count', v_count, 'event_type', p_event_type, 'reason', p_reason);
END; $function$;

CREATE OR REPLACE FUNCTION public.fn_pay_player_chips(p_user_id uuid, p_amount numeric, p_category text, p_description text, p_club_hint uuid DEFAULT NULL::uuid, p_related_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid; v_balance numeric;
BEGIN
  IF auth.role() = 'authenticated' AND p_user_id != auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('paid', false, 'reason', 'non_positive');
  END IF;

  v_club := public.fn_player_home_club(p_user_id, p_club_hint);

  IF v_club IS NULL THEN
    RAISE EXCEPTION 'no club wallet resolves for player % — Club Arena money cannot be paid to a global wallet', p_user_id
      USING HINT = 'Pass an explicit club, or ensure the player holds a club membership.';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);

  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_club
   RETURNING chip_balance INTO v_balance;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'club wallet for player % in club % could not be credited', p_user_id, v_club;
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
  VALUES
    (p_user_id, 'PLAYER', 'credit', p_amount, p_category,
     p_description || ' [club wallet]', p_related_id, v_balance);

  RETURN jsonb_build_object('paid', true, 'club_id', v_club,
                            'source', 'club_chips', 'balance_after', v_balance);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_purchase_chips(p_user_id uuid, p_amount numeric, p_diamonds_cost integer DEFAULT 0, p_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_debit jsonb;
BEGIN
  IF auth.role() = 'authenticated' AND p_user_id != auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'user required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'chip amount must be > 0');
  END IF;
  IF p_diamonds_cost IS NULL OR p_diamonds_cost < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid diamond cost');
  END IF;

  IF p_diamonds_cost > 0 THEN
    v_debit := deduct_diamonds(
      p_user_id, p_diamonds_cost, 'Chip package purchase',
      'purchase', 'chip_purchase', '{}'::jsonb, p_reference_id, 0
    );

    IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_debit->>'error', 'diamond debit failed'),
        'balance', v_debit->'balance'
      );
    END IF;
  END IF;

  PERFORM credit_player_wallet(p_user_id, p_amount);

  INSERT INTO wallet_transactions (
    user_id, wallet_type, amount, type, category, description, created_at
  ) VALUES (
    p_user_id, 'PLAYER', p_amount, 'credit', 'deposit',
    format('Chip purchase: %s chips for %s diamonds', p_amount, p_diamonds_cost), NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'chips_credited', p_amount,
    'diamonds_charged', p_diamonds_cost,
    'diamond_balance_after', v_debit->'balance',
    'idempotent', COALESCE((v_debit->>'idempotent')::boolean, false)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_purchase_club_chips(p_user_id uuid, p_club_id uuid, p_amount numeric, p_diamonds_cost integer DEFAULT 0, p_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_debit    jsonb;
  v_credit   jsonb;
  v_is_member boolean;
BEGIN
  IF auth.role() = 'authenticated' AND p_user_id != auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_user_id IS NULL OR p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'user and club required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'chip amount must be > 0');
  END IF;
  IF p_diamonds_cost IS NULL OR p_diamonds_cost < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid diamond cost');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not a member of this club');
  END IF;

  IF p_diamonds_cost > 0 THEN
    v_debit := deduct_diamonds(
      p_user_id, p_diamonds_cost, 'Club chip package purchase',
      'purchase', 'chip_purchase', jsonb_build_object('club_id', p_club_id),
      p_reference_id, 0
    );

    IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_debit->>'error', 'diamond debit failed'),
        'balance', v_debit->'balance'
      );
    END IF;

    IF COALESCE((v_debit->>'idempotent')::boolean, false) IS TRUE THEN
      RETURN jsonb_build_object(
        'success', true,
        'chips_credited', 0,
        'diamonds_charged', 0,
        'diamond_balance_after', v_debit->'balance',
        'club_id', p_club_id,
        'idempotent', true
      );
    END IF;
  END IF;

  v_credit := fn_credit_chips(
    p_club_id, p_user_id, p_amount, 'Chip package purchase',
    jsonb_build_object('transaction_type', 'chip_purchase', 'diamonds_charged', p_diamonds_cost)
  );

  IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'club chip credit failed: %', COALESCE(v_credit->>'error', 'unknown');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'chips_credited', p_amount,
    'diamonds_charged', p_diamonds_cost,
    'diamond_balance_after', v_debit->'balance',
    'club_id', p_club_id,
    'club_balance_after', v_credit->'balance_after',
    'idempotent', false
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_purchase_chips(uuid, numeric, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_purchase_club_chips(uuid, uuid, numeric, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_player_chips(uuid, numeric, text, text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_promo_payout_atomic(uuid, numeric, uuid[], text, text) TO authenticated;
