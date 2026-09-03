-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift directive).
-- This file is the byte-exact mirror of the applied migration.
-- ZERO-DRIFT PART 4: LEAK FIXES (categories set via in-body set_config;
-- ALTER FUNCTION SET on custom GUCs is not permitted on managed Postgres)

-- ── 1. promo_apply_playthrough ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.promo_apply_playthrough(p_club_id uuid, p_user_id uuid, p_wagered numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_promo    numeric;
  v_required numeric;
  v_wagered  numeric;
  v_released numeric := 0;
  v_caller   text := COALESCE(auth.role(), '');
BEGIN
  /* ZERO-DRIFT (2026-08-31): the wager figure is engine truth. Only the
     engine (service_role) or trusted admin context may apply playthrough —
     an authenticated user could previously release ANY member's locked promo
     by claiming an arbitrary wager. Fail closed. */
  IF NOT (v_caller = 'service_role'
          OR (v_caller = '' AND current_user IN ('postgres', 'supabase_admin'))) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'engine_only');
  END IF;

  IF p_wagered IS NULL OR p_wagered <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_wager');
  END IF;

  BEGIN
    INSERT INTO player_stats (id, user_id, club_id, total_losses, updated_at)
    VALUES (gen_random_uuid(), p_user_id, p_club_id, p_wagered, now())
    ON CONFLICT (user_id, club_id) DO UPDATE
       SET total_losses = player_stats.total_losses + EXCLUDED.total_losses,
           updated_at   = now();
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  SELECT COALESCE(promo_balance, 0), COALESCE(promo_playthrough_required, 0), COALESCE(promo_wagered, 0)
    INTO v_promo, v_required, v_wagered
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
   FOR UPDATE;

  IF v_promo IS NULL OR v_promo <= 0 OR v_required <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_outstanding_promo');
  END IF;

  v_wagered := v_wagered + p_wagered;

  IF v_wagered >= v_required THEN
    /* Exact release — the old v_promo::integer truncated fractions into
       nothing while promo_balance was zeroed in full. */
    v_released := round(v_promo, 2);

    PERFORM set_config('app.ledger_category', 'promo_release', true);
    PERFORM set_config('app.ledger_counterparty', 'promo_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_user_id::text, true);
    PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    UPDATE club_members
       SET chip_balance               = COALESCE(chip_balance, 0) + v_released,
           promo_balance              = 0,
           promo_playthrough_required = 0,
           promo_wagered              = 0,
           updated_at                 = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
    PERFORM set_config('app.ledger_autoskip_club_members', '0', true);

    INSERT INTO chip_transactions (id, club_id, to_user_id, amount, transaction_type, notes, created_at)
    VALUES (gen_random_uuid(), p_club_id, p_user_id, v_released, 'promo_released',
            'Promo bonus released to cashable balance after playthrough met', NOW());
  ELSE
    UPDATE club_members
       SET promo_wagered = v_wagered, updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('applied', true, 'released', v_released,
                            'wagered', v_wagered, 'required', v_required);
END;
$function$;
REVOKE ALL ON FUNCTION public.promo_apply_playthrough(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;

-- ── 2. atomic_table_rebuy ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atomic_table_rebuy(p_user_id uuid, p_table_id uuid, p_amount numeric, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new_balance numeric; v_club_id uuid; v_union_id uuid; v_ban_id uuid; v_seat_club uuid;
  v_credited integer;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_user_id)) THEN
    RAISE EXCEPTION 'Cannot rebuy for another player';
  END IF;

  PERFORM set_config('app.ledger_category', 'rebuy', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.transaction_idempotency_keys (key, user_id, action, amount)
    VALUES (p_idempotency_key, p_user_id, 'atomic_table_rebuy', p_amount) ON CONFLICT (key) DO NOTHING;
    IF NOT FOUND THEN RETURN (SELECT chip_balance FROM club_members WHERE user_id = p_user_id AND club_id = (SELECT club_id FROM table_seats WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL LIMIT 1)); END IF;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Rebuy amount must be positive';
  END IF;

  /* ZERO-DRIFT (2026-08-31): lock the seat so it cannot vacate between this
     check and the stack credit below. */
  SELECT ts.club_id INTO v_seat_club
    FROM table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id AND ts.left_at IS NULL
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not seated at this table (cannot rebuy a vacated seat)';
  END IF;

  SELECT t.club_id, c.union_id INTO v_club_id, v_union_id
    FROM tables t LEFT JOIN clubs c ON c.id = t.club_id WHERE t.id = p_table_id LIMIT 1;
  IF v_club_id IS NOT NULL THEN
    SELECT id INTO v_ban_id FROM blacklists
     WHERE user_id = p_user_id AND (expires_at IS NULL OR expires_at > now())
       AND (club_id = v_club_id OR (v_union_id IS NOT NULL AND union_id = v_union_id))
     LIMIT 1;
    IF v_ban_id IS NOT NULL THEN RAISE EXCEPTION 'Banned from this club'; END IF;
  END IF;

  IF v_seat_club IS NULL THEN
    v_seat_club := public.fn_seat_club_for_user(p_user_id, p_table_id, NULL);
  END IF;
  IF v_seat_club IS NULL THEN
    RAISE EXCEPTION 'No club wallet resolves for this rebuy';
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, v_seat_club);

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE user_id = p_user_id AND club_id = v_seat_club AND chip_balance >= p_amount
   RETURNING chip_balance INTO v_new_balance;
  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient club chips for rebuy (club %)', v_seat_club;
  END IF;

  UPDATE table_seats SET stack = stack + p_amount
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  GET DIAGNOSTICS v_credited = ROW_COUNT;
  IF v_credited = 0 THEN
    /* ZERO-DRIFT (2026-08-31): the seat vanished after the debit. Abort the
       whole transaction — debit, idempotency claim and all — so no chips are
       destroyed. This is the bug class the 2026-08-26 addon fix closed; the
       rebuy path never got the same guard. */
    RAISE EXCEPTION 'Seat disappeared during rebuy - transaction aborted, no chips moved';
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', p_amount, 'rebuy',
            'Cash game rebuy (club wallet)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$function$;

-- ── 3. fn_credit_chips (truncation fix) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_credit_chips(p_club_id uuid, p_user_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_before numeric;
  v_after numeric;
  v_amt numeric := round(p_amount, 2);
BEGIN
  IF v_amt IS NULL OR v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  PERFORM set_config('app.ledger_category', 'player_funding', true);

  SELECT COALESCE(chip_balance, 0) INTO v_before
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;

  IF v_before IS NULL THEN
    INSERT INTO club_members (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (p_club_id, p_user_id, 'player', v_amt, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_members.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
    v_before := 0;
    v_after := v_amt;
  ELSE
    /* ZERO-DRIFT (2026-08-31): was + p_amount::integer — the balance moved by
       a truncated amount while the journal recorded the full numeric amount,
       destroying fractions on every fractional call. */
    UPDATE club_members
    SET chip_balance = COALESCE(chip_balance, 0) + v_amt,
        updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_user_id;
    v_after := v_before + v_amt;
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, NULL, p_user_id, v_amt,
    COALESCE(p_metadata->>'transaction_type', 'chip_credit'),
    COALESCE(p_reason, 'Chip credit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', v_amt,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$;

-- ── 4. fn_bbj_promo_payout_atomic — club promo sink, idempotent ────────────
CREATE OR REPLACE FUNCTION public.fn_bbj_promo_payout_atomic(p_pool_id uuid, p_amount numeric, p_recipient_user_ids uuid[], p_reason text DEFAULT NULL::text, p_event_type text DEFAULT 'custom'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_pool record; v_count int; v_total_cents bigint; v_base_cents bigint;
  v_remainder_cents bigint; v_uid uuid; v_idx int := 0; v_amt numeric;
  v_club uuid; v_paid numeric := 0; v_skipped int := 0;
  v_op_key text;
  v_claimed integer;
BEGIN
  IF auth.role() = 'authenticated' THEN
      RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('success', true, 'skipped', 'zero_amount'); END IF;
  IF p_recipient_user_ids IS NULL OR array_length(p_recipient_user_ids,1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_recipients'); END IF;
  v_count := array_length(p_recipient_user_ids, 1);

  PERFORM set_config('app.ledger_category', 'bbj_payout', true);
  PERFORM set_config('app.ledger_counterparty', 'bbj_pool', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_pool_id::text, true);

  /* ZERO-DRIFT (2026-08-31): idempotency. One payout per
     (pool, event, reason, recipient set, amount) — a retried call returns
     without draining the pool twice. */
  v_op_key := 'bbjpromo:' || p_pool_id::text || ':' || p_event_type || ':'
           || COALESCE(p_reason,'') || ':' || p_amount::text || ':'
           || md5(array_to_string(p_recipient_user_ids, ','));
  INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
  VALUES (left(v_op_key, 255), p_recipient_user_ids[1], p_amount)
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN jsonb_build_object('success', true, 'already_paid', true);
  END IF;

  SELECT * INTO v_pool FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_pool.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'pool_not_found'); END IF;
  IF COALESCE(v_pool.promo_balance,0) < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_promo_balance', 'available', v_pool.promo_balance, 'requested', p_amount); END IF;

  UPDATE bbj_pools SET promo_balance = promo_balance - p_amount, pool_amount = pool_amount - p_amount,
    total_paid_out = COALESCE(total_paid_out,0) + p_amount, updated_at = NOW() WHERE id = p_pool_id;

  v_total_cents := round(p_amount * 100); v_base_cents := v_total_cents / v_count;
  v_remainder_cents := v_total_cents - v_base_cents * v_count;

  FOREACH v_uid IN ARRAY p_recipient_user_ids LOOP
    v_amt := (v_base_cents + (CASE WHEN v_idx = 0 THEN v_remainder_cents ELSE 0 END))::numeric / 100;

    /* ZERO-DRIFT (2026-08-31): the old body paid wallets(PROMO) — the pool
       frozen since 2026-08-21 that nothing reads, so the chips left live
       circulation. Pay the member's club promo balance instead. */
    v_club := COALESCE(v_pool.club_id, public.fn_player_home_club(v_uid, NULL));
    IF v_club IS NOT NULL AND EXISTS (
         SELECT 1 FROM club_members m WHERE m.user_id = v_uid AND m.club_id = v_club) THEN
      UPDATE club_members
         SET promo_balance = COALESCE(promo_balance, 0) + v_amt,
             updated_at = NOW()
       WHERE user_id = v_uid AND club_id = v_club;
      INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
      VALUES (v_club, v_uid, v_amt, 'bbj_promo_payout',
              COALESCE(p_reason, 'BBJ promo pool payout') || ' (' || p_event_type || ')');
      v_paid := v_paid + v_amt;
    ELSE
      v_skipped := v_skipped + 1;
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical', 'fn_bbj_promo_payout_atomic',
              'BBJ promo payout recipient has no club wallet - share NOT paid, returned to pool',
              jsonb_build_object('pool_id', p_pool_id, 'user_id', v_uid, 'amount', v_amt));
      UPDATE bbj_pools SET promo_balance = promo_balance + v_amt,
        pool_amount = pool_amount + v_amt,
        total_paid_out = COALESCE(total_paid_out,0) - v_amt, updated_at = NOW()
      WHERE id = p_pool_id;
    END IF;
    v_idx := v_idx + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'amount', v_paid, 'recipient_count', v_count - v_skipped,
                            'skipped', v_skipped, 'event_type', p_event_type, 'reason', p_reason);
END; $function$;

-- ── 5. log_wallet_transaction — balance_after from the live wallet ─────────
CREATE OR REPLACE FUNCTION public.log_wallet_transaction(p_user_id uuid, p_wallet_type text, p_amount numeric, p_type text, p_category text, p_description text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_bal NUMERIC; v_club uuid;
BEGIN
  /* ZERO-DRIFT (2026-08-31): club members' live balance is
     club_members.chip_balance; public.wallets has been frozen since
     2026-08-21, so reading it stamped a stale balance_after on every row. */
  IF p_wallet_type = 'PLAYER' THEN
    v_club := public.fn_player_home_club(p_user_id, NULL);
    IF v_club IS NOT NULL THEN
      SELECT chip_balance INTO v_bal FROM club_members
       WHERE user_id = p_user_id AND club_id = v_club;
    END IF;
  END IF;
  IF v_bal IS NULL THEN
    SELECT balance INTO v_bal FROM wallets WHERE user_id = p_user_id AND wallet_type = p_wallet_type;
  END IF;
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, table_id, hand_id, related_entity_id, balance_after, created_at)
  VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description, p_table_id, p_hand_id, p_related_entity_id, COALESCE(v_bal, 0), NOW());
END;
$function$;