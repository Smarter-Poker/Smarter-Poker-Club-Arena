-- ============================================================================
-- DIAMOND PHASE 11, LINE 2 - A RETRY GETS ITS FIRST RECEIPT, REHEARSED IN ONE
-- SESSION
-- ============================================================================
-- REHEARSAL ONLY. Run by the swarm's rehearse.sh against production, once with
-- an empty migration (the "before" run) and once with
-- 20260930235000_a_retry_gets_its_first_receipt.sql (the "after" run). Each run
-- is ONE transaction that ends in a deliberate RAISE EXCEPTION
-- 'REHEARSAL OK ...', so NOTHING persists: the two sessions, the admin role on
-- the system account, the Diamond event the staff door creates, the stored
-- store receipt and the claimed credit key exist only inside the rolled-back
-- transaction. No switch is opened (nobody can enter the event), no Diamond
-- moves, no real person's account is used: the staff is the platform's system
-- account, the player the synthetic horse_final_56@hydra.bot account the
-- Phase 9 and Phase 11 rehearsals also used. Neither holds a live seat.
--
-- What it proves in production's own catalogue, one session, no concurrency:
--   * the store answers a retry of a stored purchase with that receipt, word
--     for word (BEFORE: cost 0, granted false and idempotent true laid over
--     it), and still refuses the same request id for another feature by name;
--   * the prize payer, given a key another credit claimed, refuses by name
--     (BEFORE: answered false and paid nothing);
--   * fn_credit_and_log, the payer's one caller, carries that refusal for a
--     Diamond event instead of answering false - "already paid" - for a
--     payment that never happened (BEFORE: false);
--   * nothing moved: both wallets exactly as found, no Diamond ledger row,
--     movement or custody for the event, the identity unchanged, both
--     switches closed.
-- A retry answering its first receipt after a real payment, a real withdrawal
-- and a real purchase - which need an open arena and moving Diamonds - runs on
-- the isolated fixture: tests/sql/run-diamond-concurrency.py.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
DO $rehearsal$
DECLARE
  v_staff CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_player CONSTANT uuid := '00000000-0000-0000-0000-000000000056';
  v_req CONSTANT uuid := gen_random_uuid();
  v_key CONSTANT text := 'rehearsal:a-retry-gets-its-first-receipt:' || gen_random_uuid()::text;
  v_identity numeric; v_after boolean; v_mode text; v_wallets jsonb;
  v_created jsonb; v_tid uuid; v_stored jsonb; v_r jsonb; v_b boolean; v_msg text;
  v_store text; v_mismatch text; v_payer text; v_credit text;
BEGIN
  v_identity := (SELECT difference FROM public.fn_ca_diamond_register_vs_supply());
  v_after := position('diamond_tournament_pay_key_reused' IN
               pg_get_functiondef('public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text)'::regprocedure)) > 0;
  v_mode := CASE WHEN v_after THEN 'after' ELSE 'before' END;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch is open; this rehearsal expects both closed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats WHERE user_id IN (v_staff, v_player) AND left_at IS NULL) THEN
    RAISE EXCEPTION 'a rehearsal account holds a live seat; choose another';
  END IF;
  SELECT jsonb_object_agg(id::text, diamonds) INTO v_wallets FROM public.profiles WHERE id IN (v_staff, v_player);

  -- The scene, inside this transaction only.
  INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES
    (uuid_in(md5('p11-replay:' || v_staff::text)::cstring), v_staff, now(), now()),
    (uuid_in(md5('p11-replay:' || v_player::text)::cstring), v_player, now(), now());
  UPDATE public.profiles SET role = 'admin' WHERE id = v_staff;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_staff,
    'session_id', uuid_in(md5('p11-replay:' || v_staff::text)::cstring))::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.headers', '{}', true);
  -- A Diamond event in the closed arena: the payer's door and fn_credit_and_log
  -- route by the event's asset, so the refusals below are the Diamond ones.
  v_created := public.fn_poker_diamond_create_tournament(jsonb_build_object(
    'name', 'Phase 11 replay rehearsal', 'gameVariant', 'NLH', 'maxPlayers', 9, 'minPlayers', 2,
    'startingStack', 10000,
    'blindStructure', '[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
    'payoutStructure', '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb,
    'startTime', (now() + interval '1 hour')::text, 'type', 'mtt', 'buyIn', 25, 'payoutPercent', 20));
  v_tid := (v_created->>'tournamentId')::uuid;
  IF v_tid IS NULL OR NOT public.fn_poker_diamond_tournament(v_tid) THEN
    RAISE EXCEPTION 'the staff door did not create a Diamond event: %', v_created;
  END IF;

  -- From here on, the player.
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_player,
    'session_id', uuid_in(md5('p11-replay:' || v_player::text)::cstring))::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_player::text, true);

  -- 1. THE STORE. A purchase whose first answer is stored, delivered again.
  v_stored := jsonb_build_object('success', true, 'cost', 150, 'usage_type', 'permanent', 'idempotent', false,
                                 'granted', true, 'diamonds_remaining', 150);
  INSERT INTO public.digital_purchase_receipts(user_id, request_id, purchase_kind, request_payload, result)
  VALUES (v_player, v_req, 'feature', jsonb_build_object('feature', 'card_back_gold'), v_stored);
  v_r := public.fn_purchase_feature_v2(v_player, 'card_back_gold', v_req);
  IF v_after AND v_r IS DISTINCT FROM v_stored THEN
    RAISE EXCEPTION 'after the migration the store still answers a retry with something else: %', v_r;
  ELSIF NOT v_after AND NOT (v_r->>'cost' = '0' AND v_r->>'granted' = 'false' AND v_r->>'idempotent' = 'true'
                             AND v_r->>'original_cost' = '150') THEN
    RAISE EXCEPTION 'before the migration the store was expected to overlay cost 0 and granted false: %', v_r;
  END IF;
  v_store := CASE WHEN v_r = v_stored THEN 'the stored receipt word for word'
                  ELSE format('cost %s, granted %s, idempotent %s', v_r->>'cost', v_r->>'granted', v_r->>'idempotent') END;
  v_r := public.fn_purchase_feature_v2(v_player, 'card_back_dragon', v_req);
  IF v_r->>'code' IS DISTINCT FROM 'REQUEST_ID_REUSED' THEN
    RAISE EXCEPTION 'the same request id for another feature was not refused by name: %', v_r;
  END IF;
  v_mismatch := v_r->>'code';

  -- 2. THE PRIZE PAYER. A key another credit claimed, presented as a payment.
  RESET ROLE;
  INSERT INTO public.wallet_credit_idempotency(key, user_id, amount) VALUES (v_key, v_player, 7);
  BEGIN
    v_b := public.fn_poker_diamond_tournament_pay(v_player, 7, v_key, 'prize', v_tid, 'Phase 11 replay rehearsal');
    v_msg := 'answered ' || v_b::text;
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_after AND v_msg <> 'diamond_tournament_pay_key_reused' THEN
    RAISE EXCEPTION 'after the migration the payer did not refuse a claimed key by name: %', v_msg;
  ELSIF NOT v_after AND v_msg <> 'answered false' THEN
    RAISE EXCEPTION 'before the migration the payer was expected to answer false: %', v_msg;
  END IF;
  v_payer := v_msg;

  -- 3. ITS ONE CALLER, fn_credit_and_log, for the same key (a bounty: no payout
  --    evidence row is involved, so its answer is the payer's alone).
  BEGIN
    v_b := public.fn_credit_and_log(v_player, 7, v_key, 'bounty', 'Phase 11 replay rehearsal', v_tid);
    v_msg := 'answered ' || v_b::text;
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_after AND v_msg <> 'diamond_tournament_pay_key_reused' THEN
    RAISE EXCEPTION 'after the migration fn_credit_and_log did not carry the refusal: %', v_msg;
  ELSIF NOT v_after AND v_msg <> 'answered false' THEN
    RAISE EXCEPTION 'before the migration fn_credit_and_log was expected to answer false: %', v_msg;
  END IF;
  v_credit := v_msg;

  -- 4. NOTHING MOVED.
  IF (SELECT jsonb_object_agg(id::text, diamonds) FROM public.profiles WHERE id IN (v_staff, v_player)) IS DISTINCT FROM v_wallets
     OR EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger WHERE tournament_id = v_tid)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_custody WHERE target_id = v_tid)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_movements WHERE user_id = v_player AND created_at >= transaction_timestamp())
     OR EXISTS (SELECT 1 FROM public.tournament_payouts WHERE idempotency_key = v_key) THEN
    RAISE EXCEPTION 'a Diamond moved during the rehearsal';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) IS DISTINCT FROM v_identity THEN
    RAISE EXCEPTION 'the identity moved during the rehearsal';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch was opened';
  END IF;
  RAISE EXCEPTION 'REHEARSAL OK [%]: store retry answers %, the same request id for another feature is refused (%); the payer, given a key another credit claimed: %; fn_credit_and_log for that Diamond payment: %; nothing moved, identity % unchanged, switches closed',
    v_mode, v_store, v_mismatch, v_payer, v_credit, v_identity;
END $rehearsal$;
