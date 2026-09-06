-- 20260906002035_phase_7_2_a_horse_funding_names_its_player_and_can_be_keyed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 7.2, 2026-09-06 00:2x UTC):
--
-- Phase 7's "horse buy-in idempotency keys", read against the rows first.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5), so a horse's buy-in is a player's
-- buy-in and gets the same treatment. It is funded from the club treasury
-- through fn_horse_fund_from_treasury (a rebuy) or fn_horse_seat_from_treasury
-- (a first seat), and each writes its own chip_ledger leg.
--
-- Measured over seven days: 9,252 horse_funding legs, NONE of which named the
-- player they funded. The leg said club_treasury -> table_stack and the
-- table, and nothing else. So the per-account replay built hours ago (Phase
-- 7.1) can key the club side and the table side of these legs but never the
-- seat, and a person reading the journal cannot tell which horse was funded.
-- 441 pairs landed at the same table for the same amount inside a minute;
-- every one of them is a second horse buying in as far as the journal can
-- say, and none of them can be PROVEN to be, because the leg does not name
-- who. That is the gap: not a measured double-spend, an inability to tell one
-- from the other.
--
-- Both doors now name the player on the leg (description and metadata) and
-- accept an OPTIONAL p_op_id. With a key the door answers a replay once: the
-- leg carries idempotency_key 'horse_fund:<op>' and a second call with the
-- same key funds nothing and returns the first answer. Without a key nothing
-- changes but the naming, so no caller has to move first and the engine can
-- adopt it when it next ships.
--
-- The argument is added with a DEFAULT, so every existing call site keeps
-- working unchanged; the old shapes are dropped so a named-argument call
-- cannot be ambiguous between them (the overload trap that cost
-- fn_award_satellite_seat its own migration on 2026-08-31).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DROP FUNCTION IF EXISTS public.fn_horse_fund_from_treasury(uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.fn_horse_seat_from_treasury(uuid, uuid, integer, numeric);

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
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user and positive amount required');
  END IF;

  /* A KEYED CALL IS ANSWERED ONCE. The engine funds a rebuy from a bust it
     has already seen; a retry after a lost response must not fund it twice.
     With no key this is the old behaviour exactly. */
  IF p_op_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'horse_fund:' || p_op_id::text) THEN
    RETURN jsonb_build_object('success', true, 'replayed', true, 'op_id', p_op_id);
  END IF;

  SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to fund from club treasury');
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
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

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
      jsonb_build_object('user_id', p_user_id, 'op_id', p_op_id, 'door', 'fn_horse_fund_from_treasury'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (v_club_id, p_user_id, -p_amount, v_st,
              'fn_horse_fund_from_treasury: ' || v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_stack,
                            'treasury_after', v_treasury - p_amount);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
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
  v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
  IF v_floor IS NOT NULL THEN
    v_eff := GREATEST(COALESCE(v_min, 0), v_floor);
    IF v_max IS NOT NULL AND v_max > 0 THEN v_eff := LEAST(v_eff, v_max); END IF;
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
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (v_club_id, p_user_id, -p_amount, v_st,
              'fn_horse_seat_from_treasury: ' || v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  RETURN jsonb_build_object('success', true, 'treasury_after', v_treasury - p_amount);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury(uuid, uuid, integer, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_seat_from_treasury(uuid, uuid, integer, numeric, uuid) TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_horse_fund_from_treasury', 'approved', 'chip standard Phase 7.2 (2026-09-06): club treasury -> a horse''s stack (rebuy); the leg names the player and carries an optional key that answers a replay once'),
  ('fn_horse_seat_from_treasury', 'approved', 'chip standard Phase 7.2 (2026-09-06): club treasury -> a horse''s first stack; same naming and the same optional key'),
  ('fn_register_horse_for_tournament', 'approved', 'chip standard Phase 7.2 (2026-09-06): registers a horse for a tournament and declares its ledger; read at the Phase 7 gate and registered')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('fn_horse_fund_from_treasury', 'fn_horse_seat_from_treasury');
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected exactly one shape of each horse door, found %', v_n; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_horse_fund_from_treasury') NOT LIKE '%horse_fund:%' THEN
    RAISE EXCEPTION 'the rebuy door does not carry its key';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_horse_seat_from_treasury') NOT LIKE '%''user_id'', p_user_id%' THEN
    RAISE EXCEPTION 'the seat door does not name its player';
  END IF;
  IF (SELECT count(*) FROM public.fn_ca_money_rpc_drift()) <> 0 THEN
    RAISE EXCEPTION 'money rpc drift is not zero after registering the horse doors';
  END IF;
END $$;

COMMIT;
