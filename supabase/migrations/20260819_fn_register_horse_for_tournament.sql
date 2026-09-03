-- fn_register_horse_for_tournament
--
-- Recorded 2026-08-19. The function was applied straight to production (this
-- repo's migrations are intentionally stale — the CI source of truth is
-- scripts/ci/supabase-schema-manifest.json), so it existed in the live
-- database and nowhere in the repository. That is a real gap for a MONEY
-- path: rebuilding the schema from this repo would have silently dropped
-- tournament buy-ins back to the free INSERT that minted chips.
--
-- Body below is the verbatim pg_get_functiondef() output of the live
-- function, checksum-compared against production, not retyped by hand.
--
-- Why it exists: horses are seated by the engine, which has no auth.uid(),
-- so fn_register_for_tournament (which reads auth.uid()) cannot be used.
-- This is that function with the caller passed in, hard-gated to horses.

CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0; v_mystery numeric := 0;
  v_roll numeric; v_mult numeric; v_player_id uuid;
  v_is_horse boolean;
  v_ok boolean;
BEGIN
  -- HARD GATE: horses only. A human's chips are never spent without them asking.
  SELECT is_horse INTO v_is_horse FROM public.profiles WHERE id = p_user_id;
  IF NOT COALESCE(v_is_horse, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_horse');
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         club_id, name, is_bounty, is_pko, is_mystery_bounty,
         bounty_amount, mystery_bounty_min, mystery_bounty_max
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

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = p_user_id;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty');
  END IF;

  IF v_is_bounty THEN
    v_head := v_split.bounty;
    IF COALESCE(v_t.is_mystery_bounty, false) AND v_head > 0 THEN
      v_roll := random() * 100;
      IF    v_roll < 60 THEN v_mult := 0.5;
      ELSIF v_roll < 85 THEN v_mult := 1;
      ELSIF v_roll < 95 THEN v_mult := 2;
      ELSIF v_roll < 99 THEN v_mult := 3;
      ELSE                   v_mult := 13;
      END IF;
      v_mystery := round(v_head * v_mult, 2);
      v_head := v_mystery;
    END IF;
  END IF;

  IF v_split.charge > 0 THEN
    v_ok := public.atomic_deduct_wallet_and_log(
      p_user_id, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
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
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), 0,
              'registered', v_head, v_mystery, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), 0, 'registered')
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

-- Grants as they stand in production: nothing public, nothing for a logged-in
-- user. Only the engine's service_role may spend a horse's chips.
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid) TO service_role;
