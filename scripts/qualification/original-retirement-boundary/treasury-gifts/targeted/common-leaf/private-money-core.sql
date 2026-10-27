CREATE OR REPLACE FUNCTION smarter_private.original_treasury_seat_money_core(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_st text;
  v_msg text;
  v_floor numeric;
  v_min numeric;
  v_max numeric;
  v_eff numeric;
BEGIN
  PERFORM set_config('app.money_path', 'fn_horse_seat_from_treasury', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_seat_number IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user, seat and positive amount required');
  END IF;

  /* A KEYED CALL IS ANSWERED ONCE. The engine funds a rebuy from a bust it
     has already seen; a retry after a lost response must not fund it twice.
     With no key this is the old behaviour exactly. */
  IF p_op_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'horse_fund:' || p_op_id::text) THEN
    RETURN jsonb_build_object('success', true, 'replayed', true, 'op_id', p_op_id);
  END IF;

  SELECT club_id, min_buy_in, max_buy_in INTO v_club_id, v_min, v_max FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to seat from club treasury');
  END IF;

  -- CHIP CONTINUITY (I7): the same floor a human meets at atomic_table_buyin.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
  v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
  IF v_max IS NOT NULL AND v_max > 0 AND p_amount > GREATEST(v_max, COALESCE(v_floor, 0)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'BUYIN_ABOVE_MAX');
  END IF;
  IF v_floor IS NOT NULL THEN
    v_eff := GREATEST(COALESCE(v_min, 0), v_floor);
    -- The return floor is never reduced to the ordinary maximum.
    IF p_amount < v_eff THEN
      RETURN jsonb_build_object('success', false, 'error', 'BUYIN_BELOW_FLOOR', 'required', v_eff);
    END IF;
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  BEGIN
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, is_sitting_out)
    VALUES (p_table_id, p_user_id, p_seat_number, p_amount, false);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'seat already taken');
  END;

  -- CHIP CONTINUITY: the session opens with the seat, baseline = this buy-in.
  PERFORM public.fn_cash_session_open(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse seated + funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  BEGIN
    /* PHASE 7.2 (2026-09-06): the leg NAMES THE PLAYER and carries the
       caller's key when it has one. Before this a horse funding said only
       that a table was funded: 9,252 legs in seven days, none naming the
       seat, so no per-seat audit could read them and a replay could not be
       told from a second horse buying in for the same amount at the same
       table. The key is optional: without it nothing changes but the name. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, table_id, description, idempotency_key, metadata)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury', v_club_id,
      'table_stack',   p_table_id,
      p_amount, 'horse_funding', v_club_id, p_table_id,
      'Seated + funded from club treasury (fn_horse_seat_from_treasury) for ' || p_user_id::text,
      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'horse_fund:' || p_op_id::text END,
      jsonb_build_object('user_id', p_user_id, 'op_id', p_op_id, 'door', 'fn_horse_seat_from_treasury'));
  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN jsonb_build_object('success', true, 'treasury_after', v_treasury - p_amount);
END;
$function$;

REVOKE ALL ON FUNCTION smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
