-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823224158 "register_for_tournament_seats_late_entrants"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5697c4637476cf01e85f4b1e0da62ca2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_register_for_tournament(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0; v_mystery numeric := 0;
  v_roll numeric; v_mult numeric; v_player_id uuid;
  v_late_open boolean := false; v_ok boolean;
  v_start_chips integer := 0;
  v_mb_min_mult numeric; v_mb_max_mult numeric;
  v_seat jsonb := NULL;                                  -- LATE SEAT 2026-08-23
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount, mystery_bounty_min, mystery_bounty_max,
         start_time, authorized_to_register, is_vip_only, early_bird_enabled, early_bird_chips
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

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
  IF EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = p_tournament_id AND user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  -- PARITY GATE 1 (2026-08-22): owner-approved registration list.
  IF COALESCE(v_t.authorized_to_register, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.tournament_registration_approvals a
                    WHERE a.tournament_id = p_tournament_id AND a.user_id = v_uid)
       AND NOT public.is_club_admin(v_t.club_id, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized_to_register');
    END IF;
  END IF;

  -- PARITY GATE 2 (2026-08-22): VIP-only events.
  IF COALESCE(v_t.is_vip_only, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles pr
                    WHERE pr.id = v_uid AND COALESCE(pr.is_vip, false)
                      AND (pr.vip_expires_at IS NULL OR pr.vip_expires_at > now()))
       AND NOT EXISTS (SELECT 1 FROM public.club_members m
                        WHERE m.club_id = v_t.club_id AND m.user_id = v_uid
                          AND m.role IN ('owner', 'admin', 'agent')) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'vip_only');
    END IF;
  END IF;

  -- PARITY 3 (2026-08-22): early bird bonus chips for pre-start registration.
  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = v_uid;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty',
      'detail', format('bounty %s + rake %s exceeds buy-in %s',
                       v_split.bounty, v_split.rake, v_split.charge));
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
      -- PARITY 4 (2026-08-22): rescale ladder to the advertised money range.
      IF COALESCE(v_t.mystery_bounty_min, 0) > 0
         AND COALESCE(v_t.mystery_bounty_max, 0) > v_t.mystery_bounty_min THEN
        v_mb_min_mult := v_t.mystery_bounty_min / v_head;
        v_mb_max_mult := v_t.mystery_bounty_max / v_head;
        v_mult := v_mb_min_mult + (v_mult - 0.5) * (v_mb_max_mult - v_mb_min_mult) / 12.5;
      END IF;
      v_mystery := round(v_head * v_mult, 2);
      v_head := v_mystery;
    END IF;
  END IF;

  IF v_split.charge > 0 THEN
    v_ok := public.atomic_deduct_wallet_and_log(
      v_uid, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament') ||
        CASE WHEN v_is_bounty
             THEN ' (' || v_split.prize || ' prize + ' || v_split.bounty || ' bounty + ' || v_split.rake || ' fee)'
             WHEN v_split.rake > 0
             THEN ' (' || v_split.prize || ' + ' || v_split.rake || ' fee)'
             ELSE '' END,
      NULL, NULL, p_tournament_id);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM public.log_wallet_transaction(
      v_uid, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
  END IF;

  BEGIN
    IF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, v_mystery, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    IF v_split.charge > 0 THEN
      PERFORM public.credit_player_wallet(v_uid, v_split.charge,
        'tourn_reg_race:' || p_tournament_id::text || ':' || v_uid::text);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',v_uid,'registration_id',v_player_id));
  END IF;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id;

  -- LATE SEAT 2026-08-23
  -- A late entrant is admitted into a tournament that is ALREADY DEALING.
  -- There is no start() left to seat him, so the seat is part of the same
  -- transaction as the debit: he is either a seated player with chips, or he
  -- did not pay. A refusal here (every table full, or a seat race) is not an
  -- error - the row stays 'registered' and the engine's 5s sweep seats him.
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, v_uid);
  END IF;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'bounty_head', CASE WHEN v_head > 0 THEN v_head END,
    'mystery_bounty', CASE WHEN v_mystery > 0 THEN v_mystery END,
    'early_bird_chips', CASE WHEN v_start_chips > 0 THEN v_start_chips END,
    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23
END; $function$;
