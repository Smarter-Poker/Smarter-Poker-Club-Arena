-- Why: keyed funding replay did not bind its payload or serialize concurrent callers.
-- What: authorize, serialize and verify the original journal receipt before replaying it.
-- Evidence: isolated replay, concurrency and rollback tests; no production test transfers.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)'::regprocedure))
  IS DISTINCT FROM '1916e6ce31f0ffd85d2b975e7c95490b' THEN
  RAISE EXCEPTION 'Horse funding definition changed; re-review';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury(p_table_id uuid, p_user_id uuid, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_new_stack numeric;
  v_st text;
  v_msg text;
  v_prior public.chip_ledger;
  v_skip text := COALESCE(current_setting('app.ledger_autoskip_clubs',true),'');
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount<>round(p_amount,2) THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user and positive amount required');
  END IF;

  SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to fund from club treasury');
  END IF;

  IF p_op_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('horse_fund:'||p_op_id::text,0));
    SELECT * INTO v_prior FROM public.chip_ledger
      WHERE idempotency_key='horse_fund:'||p_op_id::text;
    IF FOUND THEN
      IF v_prior.table_id IS DISTINCT FROM p_table_id
       OR v_prior.club_id IS DISTINCT FROM v_club_id
       OR v_prior.amount IS DISTINCT FROM p_amount
       OR v_prior.metadata->>'user_id' IS DISTINCT FROM p_user_id::text
       OR v_prior.category IS DISTINCT FROM 'horse_funding'
       OR v_prior.from_type IS DISTINCT FROM 'club_treasury'
       OR v_prior.to_type IS DISTINCT FROM 'table_stack' THEN
        RAISE EXCEPTION 'Horse funding identity reused with different payload' USING ERRCODE='22023';
      END IF;
      RETURN jsonb_build_object('success',true,'replayed',true,'op_id',p_op_id,
        'table_id',p_table_id,'user_id',p_user_id,'club_id',v_club_id,'amount',p_amount,
        'new_stack',v_prior.metadata->'new_stack','treasury_after',v_prior.metadata->'treasury_after');
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

  UPDATE table_seats
  SET stack = COALESCE(stack, 0) + p_amount
  WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
  RETURNING stack INTO v_new_stack;

  IF v_new_stack IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active seat for user at table');
  END IF;

  -- CHIP CONTINUITY: a horse's reload raises its baseline exactly as a human's.
  PERFORM public.fn_cash_session_add_baseline(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', v_skip, true);

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse buy-in/rebuy funded from club treasury',
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
      'Buy-in/rebuy funded from club treasury (fn_horse_fund_from_treasury) for ' || p_user_id::text,
      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'horse_fund:' || p_op_id::text END,
      jsonb_build_object('user_id', p_user_id, 'op_id', p_op_id, 'door', 'fn_horse_fund_from_treasury',
        'new_stack',v_new_stack,'treasury_after',v_treasury-p_amount));
  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_stack,
                            'treasury_after', v_treasury - p_amount,'op_id',p_op_id,
                            'table_id',p_table_id,'user_id',p_user_id,'club_id',v_club_id,'amount',p_amount);
END;
$function$;

NOTIFY pgrst,'reload schema';
COMMIT;
