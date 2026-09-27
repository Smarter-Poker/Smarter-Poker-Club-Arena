-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815065336 "fn_register_tournament_fee_row_fk_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b34da139b46c1763ebdea013231fc51c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Probe-caught fix: rake_records.table_id has an FK to tables; a tournament id
-- does not belong there (the existing tournamentRecovery.ts writer has the
-- same latent FK violation — fixed in code separately). Fee rows carry the
-- tournament only in tournament_id; table_id stays NULL.

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_t record;
  v_username text;
  v_buyin numeric; v_fee numeric; v_cost numeric;
  v_is_bounty boolean; v_bounty numeric := 0; v_mystery numeric := 0;
  v_roll numeric; v_mult numeric;
  v_player_id uuid;
  v_late_open boolean := false;
  v_ok boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         mystery_bounty_min, mystery_bounty_max
    INTO v_t
  FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF v_t.status = 'RUNNING' THEN
    IF COALESCE(v_t.late_reg_levels, 0) > 0 THEN
      v_late_open := COALESCE(v_t.current_level, 1) <= v_t.late_reg_levels;
    ELSIF COALESCE(v_t.late_reg_mins, 0) > 0 AND v_t.started_at IS NOT NULL THEN
      v_late_open := now() < v_t.started_at + make_interval(mins => v_t.late_reg_mins);
    END IF;
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  IF v_t.max_players IS NOT NULL AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id = p_tournament_id AND user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = v_uid;

  v_buyin := trunc(COALESCE(v_t.buy_in_amount, 0) * 100) / 100;
  v_fee   := trunc(COALESCE(v_t.buy_in_fee, 0) * 100) / 100;
  v_cost  := v_buyin + v_fee;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);
  IF v_is_bounty THEN
    v_bounty := COALESCE(v_t.bounty_amount, 0);
    IF COALESCE(v_t.is_mystery_bounty, false) THEN
      v_roll := random() * 100;
      IF v_roll < 60 THEN v_mult := COALESCE(v_t.mystery_bounty_min, 1);
      ELSIF v_roll < 85 THEN v_mult := 2;
      ELSIF v_roll < 95 THEN v_mult := 5;
      ELSIF v_roll < 99 THEN v_mult := 10;
      ELSE v_mult := COALESCE(v_t.mystery_bounty_max, 50);
      END IF;
      v_mystery := trunc(v_bounty * v_mult * 100) / 100;
      v_bounty := v_mystery;
    END IF;
  END IF;

  IF v_cost > 0 THEN
    v_ok := public.atomic_deduct_wallet_and_log(
      v_uid, v_cost, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament') ||
        CASE WHEN v_fee > 0 THEN ' (' || v_buyin || ' + ' || v_fee || ' fee)' ELSE '' END,
      NULL, NULL, p_tournament_id);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status,
         current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username, 'Player'), 0, 'registered',
              v_bounty, v_mystery, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username, 'Player'), 0, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF v_cost > 0 THEN
      PERFORM public.credit_player_wallet(v_uid, v_cost, 'tourn_reg_race:' || p_tournament_id::text || ':' || v_uid::text);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;

  IF v_fee > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES
      (NULL, NULL, v_t.club_id, v_fee, v_fee, 1,
       0, true, p_tournament_id, 'fn_register_for_tournament',
       jsonb_build_object('kind', 'tournament_entry_fee', 'user_id', v_uid,
                          'registration_id', v_player_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool = COALESCE(prize_pool, 0) + v_buyin
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
                            'cost', v_cost,
                            'mystery_bounty', CASE WHEN v_mystery > 0 THEN v_mystery END);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_unregister_from_tournament(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','extensions'
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_t       record;
  v_reg_id  uuid;
  v_amount  numeric;
  v_buyin   numeric;
  v_fee     numeric;
  v_ms      numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_unregister_from_tournament requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, start_time, current_players, club_id, name
    INTO v_t
  FROM public.tournaments
  WHERE id = p_tournament_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  IF v_t.start_time IS NOT NULL THEN
    v_ms := EXTRACT(EPOCH FROM (v_t.start_time - now())) * 1000;
    IF v_ms <= 60000 AND v_ms > -300000 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'too_close_to_start');
    END IF;
  END IF;

  DELETE FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = v_uid
     AND status = 'registered'
  RETURNING id INTO v_reg_id;

  IF v_reg_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_registered_or_seated');
  END IF;

  v_buyin  := trunc(COALESCE(v_t.buy_in_amount, 0) * 100) / 100;
  v_fee    := trunc(COALESCE(v_t.buy_in_fee, 0) * 100) / 100;
  v_amount := v_buyin + v_fee;

  IF v_amount > 0 THEN
    PERFORM public.credit_player_wallet(v_uid, v_amount, 'tourn_unreg:' || v_reg_id::text);
  END IF;

  IF v_fee > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES
      (NULL, NULL, v_t.club_id, -v_fee, v_fee, 1,
       0, true, p_tournament_id, 'fn_unregister_from_tournament',
       jsonb_build_object('kind', 'tournament_fee_refund', 'user_id', v_uid,
                          'registration_id', v_reg_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = GREATEST(COALESCE(current_players, 1) - 1, 0),
         prize_pool = GREATEST(COALESCE(prize_pool, 0) - v_buyin, 0)
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'refunded', v_amount, 'registration_id', v_reg_id);
END;
$$;
