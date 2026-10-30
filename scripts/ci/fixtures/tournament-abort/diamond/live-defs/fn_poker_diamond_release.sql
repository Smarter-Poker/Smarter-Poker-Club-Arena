-- live_md5 f52d63d2163f3f85dfe1e72a1ef267e7
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_release(p_custody_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner uuid;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_prev public.poker_diamond_movements%ROWTYPE;
  v_request jsonb;
  v_credit jsonb;
  v_receipt jsonb;
  v_lot record;
  v_debt_journal uuid;
BEGIN
  IF p_custody_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_diamond_release' USING ERRCODE = '22023';
  END IF;

  SELECT user_id INTO v_owner
    FROM public.poker_diamond_custody
   WHERE id = p_custody_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_custody_not_found';
  END IF;

  -- The wallet always locks before its custody, exactly as reserve does.
  -- NO KEY UPDATE, not UPDATE (20261021234940): it still serializes every
  -- writer of this wallet (FOR UPDATE, NO KEY UPDATE and UPDATE all
  -- refuse it), and it no longer refuses the FOR KEY SHARE that a
  -- foreign-key check from a row pointing at this profile takes.
  PERFORM id FROM public.profiles WHERE id = v_owner FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;
  SELECT * INTO v_c
    FROM public.poker_diamond_custody
   WHERE id = p_custody_id
   FOR UPDATE;

  v_request := jsonb_build_object(
    'action', 'release',
    'custody_id', p_custody_id,
    'user_id', v_owner
  );

  SELECT * INTO v_prev
    FROM public.poker_diamond_movements
   WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_payload_mismatch';
    END IF;
    RETURN v_prev.receipt;
  END IF;

  IF v_c.state = 'released' THEN
    RAISE EXCEPTION 'diamond_custody_already_released';
  END IF;
  -- A DIAMOND TOURNAMENT ENTRY GOES HOME ONLY THROUGH ITS REFUND AUTHORITY
  -- (Phase 8). fn_poker_diamond_tournament_refund names this row in a
  -- transaction-local setting for the one call it makes; any other caller,
  -- service role included, is refused. An entry in play is never releasable.
  IF v_c.purpose = 'tournament_entry'
     AND current_setting('app.poker_diamond_tournament_release', true) IS DISTINCT FROM p_custody_id::text THEN
    RAISE EXCEPTION 'diamond_tournament_entry_requires_refund_authority' USING ERRCODE = '42501';
  END IF;
  -- An ACTIVE tournament entry (activated by the entry door, as the seat
  -- guards P0810-P0812 require) is released whole by its refund authority;
  -- the settlement test below is the cash seat's and stays the cash seat's.
  IF v_c.state <> 'reserved' AND v_c.purpose <> 'tournament_entry' THEN
    IF v_c.state <> 'active' OR v_c.purpose <> 'cash_seat'
       OR v_c.occupancy_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.id=v_c.seat_id AND s.joined_at=v_c.seat_joined_at
            AND s.occupancy_id=v_c.occupancy_id AND s.user_id=v_c.user_id
            AND s.table_id=v_c.target_id AND s.left_at IS NOT NULL
            AND s.stack=v_c.balance) THEN
      RAISE EXCEPTION 'diamond_custody_requires_settlement';
    END IF;
  END IF;

  FOR v_lot IN
    SELECT l.id, r.amount-r.consumed AS amount
      FROM public.poker_diamond_lot_reservations r
      JOIN public.diamond_purchase_lots l ON l.id = r.lot_id
     WHERE r.custody_id = p_custody_id
       AND r.released_at IS NULL
     ORDER BY l.created_at, l.id
     FOR UPDATE OF l
  LOOP
    UPDATE public.diamond_purchase_lots
       SET arena_reserved = arena_reserved - v_lot.amount
     WHERE id = v_lot.id;
  END LOOP;

  UPDATE public.poker_diamond_lot_reservations
     SET released_at = now()
   WHERE custody_id = p_custody_id
     AND released_at IS NULL;

  IF v_c.balance > 0 THEN
  v_credit := public.add_diamonds_to_balance(
    v_owner,
    v_c.balance::integer,
    'arena_withdraw',
    'Released Poker Arena reservation',
    'poker-release:' || p_custody_id || ':' || p_request_id
  );
  IF (v_credit->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'diamond_release_credit_failed:%', v_credit->>'error';
  END IF;

  ELSE
    SELECT jsonb_build_object('success',true,'new_balance',diamonds,
      'debt_settled',0,'transaction_id',NULL) INTO v_credit
      FROM public.profiles WHERE id=v_owner;
  END IF;

  IF COALESCE((v_credit->>'debt_settled')::bigint, 0) > 0 THEN
    SELECT id INTO v_debt_journal
      FROM public.diamond_transactions
     WHERE user_id = v_owner
       AND reference_id = 'debt-settlement:' || (v_credit->>'transaction_id')
       AND type = 'debt_settlement'
       AND amount = -(v_credit->>'debt_settled')::bigint;
    IF v_debt_journal IS NULL THEN
      RAISE EXCEPTION 'diamond_debt_journal_missing';
    END IF;

    PERFORM public.fn_ca_register_diamond_journal_row(v_debt_journal);
    IF NOT EXISTS (
      SELECT 1
        FROM public.ca_mint_ledger
       WHERE diamond_tx_id = v_debt_journal
         AND action = 'burn'
         AND asset = 'diamonds'
         AND holder_type = 'player'
         AND holder_id = v_owner
         AND amount = (v_credit->>'debt_settled')::bigint
    ) THEN
      RAISE EXCEPTION 'diamond_debt_retirement_missing';
    END IF;
  END IF;

  UPDATE public.poker_diamond_custody
     SET balance = 0,
         state = 'released',
         released_at = now()
   WHERE id = p_custody_id;

  v_receipt := jsonb_build_object(
    'success', true,
    'custody_id', p_custody_id,
    'request_id', p_request_id,
    'amount', v_c.balance,
    'available_balance', (v_credit->>'new_balance')::bigint,
    'custody_balance', 0,
    'debt_settled', (v_credit->>'debt_settled')::bigint,
    'journal_id', v_credit->>'transaction_id'
  );

  INSERT INTO public.poker_diamond_movements(
    request_id, custody_id, user_id, action, amount,
    source_account, destination_account, wallet_journal_id, request, receipt
  ) VALUES (
    p_request_id, p_custody_id, v_owner, 'release', v_c.balance,
    'arena_custody:' || p_custody_id, 'player:' || v_owner,
    (v_credit->>'transaction_id')::uuid, v_request, v_receipt
  );

  RETURN v_receipt;
END;
$function$

