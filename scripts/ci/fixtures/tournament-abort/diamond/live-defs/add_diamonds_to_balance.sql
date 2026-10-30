-- live_md5 06177aba483ac900056a9b4d769e1870
CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text DEFAULT 'bonus'::text, p_description text DEFAULT NULL::text, p_reference_id text DEFAULT NULL::text, p_counterparty_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_old_balance bigint;
  v_new_balance bigint;
  v_txn_id uuid;
  v_multiplier numeric(4,2) := 1.00;
  v_raw_amount integer := COALESCE(p_amount, 0);
  v_actual_amount bigint;
  v_exact_type boolean;
  v_type_key text := COALESCE(p_type, 'unknown');
  v_issuance_class text;
  v_counterparty text;
  v_settled bigint := 0;
  v_settled_ids uuid[] := '{}';
  v_debt record;
  v_take bigint;
  v_settle_ref text;
BEGIN
  v_exact_type := p_type IN (
    'trivia_entry', 'trivia_run', 'trivia_daily_bonus', 'trivia_prize_wheel',
    'pvp_stake', 'pvp_win', 'pvp_refund', 'pvp_tie_refund',
    'tournament_entry', 'tournament_entry_refund',
    'tournament_cancel_refund', 'tournament_prize',
    'daily_mission_milestone', 'arena_withdraw'
  );

  IF p_reference_id IS NULL AND v_exact_type THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required', 'reference_required', true);
  END IF;

  IF p_reference_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.diamond_transactions WHERE user_id = p_user_id AND reference_id = p_reference_id
  ) THEN
    SELECT balance_after INTO v_new_balance FROM public.diamond_transactions
     WHERE user_id = p_user_id AND reference_id = p_reference_id LIMIT 1;
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_reference', 'duplicate', true, 'new_balance', v_new_balance);
  END IF;

  -- DR4 (DIAMOND-RULINGS 17): a positive credit without a reference is refused once the rule
  -- is flipped in ca_diamond_rule_modes. Until then it is journaled and filed below.
  IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL
     AND public.fn_ca_diamond_rule_mode('DR4:credit_without_reference') = 'refuse' THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required',
                              'reference_required', true, 'refused_by', 'DR4:credit_without_reference');
  END IF;

  SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
    INTO v_old_balance, v_multiplier
    FROM public.profiles WHERE id = p_user_id FOR NO KEY UPDATE;
    -- NO KEY UPDATE, not UPDATE (20261021234940): it still serializes every
    -- writer of this wallet (FOR UPDATE, NO KEY UPDATE and UPDATE all
    -- refuse it), and it no longer refuses the FOR KEY SHARE that a
    -- foreign-key check from a row pointing at this profile takes.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;

  IF v_raw_amount > 0 AND NOT v_exact_type
     AND p_type NOT IN ('purchase', 'deduction', 'adjustment', 'refund', 'transfer',
                        'diamond_gift_received', 'diamond_gift_sent', 'diamond_gift_refund',
                        'diamond_received', 'live_gift_received', 'live_gift_sent',
                        'vip_daily', 'vip_stipend')
     AND v_multiplier > 1.00 THEN
    v_actual_amount := round(v_raw_amount * v_multiplier);
  ELSE
    v_actual_amount := v_raw_amount;
    v_multiplier := 1.00;
  END IF;

  IF v_actual_amount < -2147483648 OR v_actual_amount > 2147483647 THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_amount_out_of_range', 'new_balance', v_old_balance);
  END IF;

  v_new_balance := v_old_balance + v_actual_amount;
  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_diamonds', 'new_balance', v_old_balance);
  END IF;
  IF v_new_balance > 2147483647 THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_balance_limit', 'new_balance', v_old_balance);
  END IF;

  IF v_type_key = 'arena_withdraw' THEN
    v_issuance_class := 'arena'; v_counterparty := 'arena_custody:' || p_reference_id;
  ELSIF v_type_key = 'purchase' THEN
    v_issuance_class := 'purchased'; v_counterparty := 'purchase_clearing';
  ELSIF v_type_key = 'refund' OR right(v_type_key, 7) = '_refund' THEN
    v_issuance_class := 'refund'; v_counterparty := 'revenue:' || v_type_key;
  ELSIF v_type_key IN ('transfer', 'diamond_gift_received', 'live_gift_received', 'diamond_received') THEN
    -- NAME THE OTHER SIDE. ab_ca_diamond_transfer_names_its_counterparty refuses
    -- a transfer that cannot, because the register skips a transfer on the row's own
    -- word that a matching leg exists somewhere.
    v_issuance_class := 'transferred';
    v_counterparty := 'player:' || COALESCE(p_counterparty_id::text, 'unknown');
  ELSIF v_type_key = 'adjustment' THEN
    v_issuance_class := 'admin'; v_counterparty := 'adjustment';
  ELSIF v_type_key IN ('union_grant', 'signup_bonus') THEN
    v_issuance_class := 'promotional'; v_counterparty := 'promo_budget:' || v_type_key;
  ELSIF v_actual_amount < 0 THEN
    v_issuance_class := 'spend'; v_counterparty := 'revenue:' || v_type_key;
  ELSE
    v_issuance_class := 'earned'; v_counterparty := 'promo_budget:' || v_type_key;
  END IF;

  -- Kill switch (standard 3.4 layer 6, review D11): a human-opened diamond_issuance freeze refuses
  -- promotional and earned credits. Purchases, refunds, transfers and adjustments are not issuance.
  IF v_actual_amount > 0 AND v_issuance_class IN ('earned', 'promotional')
     AND EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_issuance_frozen', 'new_balance', v_old_balance);
  END IF;

  -- DIAMOND-RULINGS 2: a chargeback the balance could not cover is a receivable, never a
  -- negative balance, and the next positive credit of any class settles open receivables
  -- oldest first before the player sees the rest. A debt larger than the credit is split:
  -- the paid part becomes its own settled row, the residual stays open.
  IF v_actual_amount > 0 THEN
    FOR v_debt IN
      SELECT d.id, d.amount FROM public.diamond_debts d
       WHERE d.user_id = p_user_id AND d.settled_at IS NULL
       ORDER BY d.created_at, d.id
       FOR UPDATE
    LOOP
      EXIT WHEN v_settled >= v_actual_amount;
      v_take := LEAST(v_debt.amount, v_actual_amount - v_settled);
      IF v_take >= v_debt.amount THEN
        UPDATE public.diamond_debts SET settled_at = now(), settled_by = 'add_diamonds_to_balance'
         WHERE id = v_debt.id;
      ELSE
        UPDATE public.diamond_debts SET amount = amount - v_take WHERE id = v_debt.id;
        INSERT INTO public.diamond_debts (user_id, purchase_id, amount, reason, created_at, settled_at, settled_by)
        SELECT d.user_id, d.purchase_id, v_take,
               d.reason || ' (partial settlement of ' || d.id::text || ')',
               d.created_at, now(), 'add_diamonds_to_balance'
          FROM public.diamond_debts d WHERE d.id = v_debt.id;
      END IF;
      v_settled := v_settled + v_take;
      v_settled_ids := v_settled_ids || v_debt.id;
    END LOOP;
  END IF;

  UPDATE public.profiles
     SET diamonds = v_new_balance - v_settled, diamond_balance = v_new_balance - v_settled, updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.diamond_transactions (
    user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata,
    counterparty, issuance_class
  ) VALUES (
    p_user_id, v_actual_amount, p_type, p_type,
    CASE WHEN v_actual_amount <> v_raw_amount
         THEN COALESCE(p_description, '') || format(' [%sx boost]', v_multiplier)
         ELSE p_description END,
    v_new_balance, p_reference_id,
    jsonb_build_object('reference_id', p_reference_id, 'raw_amount', v_raw_amount,
                       'multiplier', v_multiplier, 'exact_value', v_exact_type),
    v_counterparty, v_issuance_class
  ) RETURNING id INTO v_txn_id;

  IF v_settled > 0 THEN
    -- The settlement is its own journal row (class spend, counterparty the receivable), so the
    -- register retires what the reversed purchase had issued and the player's statement shows
    -- both the credit and what it paid off.
    v_settle_ref := 'debt-settlement:' || v_txn_id::text;
    INSERT INTO public.diamond_transactions (
      user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata,
      counterparty, issuance_class
    ) VALUES (
      p_user_id, -v_settled, 'debt_settlement', 'debt_settlement',
      'Settled ' || v_settled::text || ' diamonds owed after a reversed purchase',
      v_new_balance - v_settled, v_settle_ref,
      jsonb_build_object('reference_id', v_settle_ref, 'credit_transaction_id', v_txn_id,
                         'settled_debt_ids', to_jsonb(v_settled_ids), 'raw_amount', -v_settled,
                         'multiplier', 1.00, 'exact_value', true),
      'receivable:diamond_debts', 'spend'
    );
  END IF;

  -- DIAMOND-RULINGS 1: a debit through this door consumes purchased lots first (FIFO).
  IF v_actual_amount < 0 THEN
    PERFORM public.fn_ca_consume_purchase_lots(p_user_id, -v_actual_amount);
  END IF;

  IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR4:credit_without_reference', 'warning', p_user_id, p_amount,
        'add_diamonds_to_balance', jsonb_build_object('type', p_type, 'description', p_description));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object('success', true, 'old_balance', v_old_balance,
                            'new_balance', v_new_balance - v_settled,
                            'amount', v_actual_amount, 'multiplier', v_multiplier, 'transaction_id', v_txn_id,
                            'debt_settled', v_settled);
END;
$function$

