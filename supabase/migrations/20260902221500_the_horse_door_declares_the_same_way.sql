-- ═══════════════════════════════════════════════════════════════════════════════
--  THE HORSE DOOR DECLARES THE SAME WAY
--  Chip Accounting Roadmap Phase 1.2, second door (follows 20260902220500)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Found one minute after 20260902220500 applied: `adjustment player_wallet ->
-- table_stack` rows kept arriving (36 in the first 70 seconds), every one a
-- "Tournament buy-in: <spin | heads-up>" for a horse. The horse fleet does not
-- register through fn_register_for_tournament (auth.uid()-bound); it calls
-- fn_register_horse_for_tournament(p_tournament_id, p_user_id), service_role
-- only, the same body shape with the same undeclared atomic_deduct_wallet_and_log
-- call. It is the larger share of the 19,538 rows a day.
--
-- Live body (pg_get_functiondef, 2026-09-02 22:08 UTC, prosrc 4,958 bytes) with
-- the same lines ADDED as the human door, nothing else touched. set_config rather
-- than fn_ca_declare_ledger, deliberately: R11 says a horse and a human are
-- identical on every path, and the human door uses set_config so a vocabulary
-- miss can never refuse a buy-in. Grants untouched.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_is_horse boolean;
  v_ok boolean;
  v_start_chips integer := 0;
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  SELECT is_horse INTO v_is_horse FROM public.profiles WHERE id = p_user_id;
  IF NOT COALESCE(v_is_horse, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_horse');
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         club_id, name, is_bounty, is_pko, is_mystery_bounty,
         bounty_amount, start_time, early_bird_enabled, early_bird_chips
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  IF v_t.max_players IS NOT NULL AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id = p_tournament_id AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = p_user_id;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty');
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: no roll here either. A horse and a human must
  -- enter the same event on the same terms; when the two register functions
  -- disagreed about how a bounty head was set, they were two tournaments.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR DECLARES EXACTLY AS THE HUMAN
    -- DOOR (R11 - horses and humans are identical on every path). The wallet write
    -- below is journaled by trg_club_members_audit_chip_movement; undeclared it landed
    -- as adjustment player_wallet -> table_stack with no tournament. set_config, not
    -- fn_ca_declare_ledger, for the same reason as fn_register_for_tournament: a
    -- vocabulary miss must never refuse a buy-in. Restored right after the write.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    v_ok := public.atomic_deduct_wallet_and_log(
      p_user_id, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      p_user_id, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips,
              'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF v_split.charge > 0 THEN
      PERFORM public.credit_player_wallet(p_user_id, v_split.charge,
        'tourn_reg_race:' || p_tournament_id::text || ':' || p_user_id::text);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_horse_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',p_user_id,
                               'registration_id',v_player_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake);
END; $function$

;

DO $assert$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_register_horse_for_tournament' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%set_config(''app.ledger_category'', ''tournament_buyin'', true)%'
     OR v_src NOT LIKE '%set_config(''app.ledger_counterparty'', ''prize_liability'', true)%'
     OR v_src NOT LIKE '%set_config(''app.ledger_tournament'', p_tournament_id::text, true)%' THEN
    RAISE EXCEPTION 'fn_register_horse_for_tournament does not declare tournament_buyin -> prize_liability';
  END IF;
  IF v_src LIKE '%RAISE EXCEPTION%' THEN
    RAISE EXCEPTION 'fn_register_horse_for_tournament grew a refusal';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_register_horse_for_tournament(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_register_horse_for_tournament(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_register_horse_for_tournament(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a grant moved; this migration must not change who may call';
  END IF;
END $assert$;

COMMIT;
