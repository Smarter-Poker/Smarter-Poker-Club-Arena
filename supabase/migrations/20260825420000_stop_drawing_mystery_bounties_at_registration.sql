-- ═══════════════════════════════════════════════════════════════════════════
--  STOP DRAWING MYSTERY BOUNTIES AT REGISTRATION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Both registration functions carried the same twenty lines: a `random() * 100`
-- roll into a five-step multiplier ladder, rescaled against
-- mystery_bounty_min/max, written to `tournament_players.mystery_bounty_value`
-- and `.current_bounty` at the moment the player paid.
--
-- Deleted, for the three reasons set out in the migration that created the
-- chest inventory (20260825410000):
--
--   * `random()` is a seeded PRNG that any session can `setseed()`;
--   * the value sat in a readable row for the whole event, so which head was
--     worth chasing was public before a card was dealt;
--   * independent per-player rolls are a draw WITH replacement, so what the
--     event paid out had no arithmetic relationship to the pool that funded
--     it. Nothing anywhere compared the two.
--
-- WHAT A MYSTERY EVENT DOES NOW AT REGISTRATION: exactly what a fixed-bounty
-- event does. The entry split still routes `bounty` into `tournaments.bounty_pool`,
-- and the player still carries the flat `bounty_amount` on their head. That
-- head is what pays out for knockouts BEFORE the mystery phase opens, from the
-- regular half of the pool — those players busted during late registration and
-- are owed something, and a flat bounty is what every other format pays them.
--
-- Once entry closes and the threshold is reached, the engine seeds the chest
-- inventory and fn_collect_bounty refuses (`mystery_phase_active`); from then
-- on knockouts go through fn_mystery_bounty_reserve.
--
-- `mystery_bounty_min` / `mystery_bounty_max` are no longer read by either
-- function. They are left on the table because 9,000 historical tournaments
-- carry them and the lobby still renders them as an advertised range; the
-- range that will actually be paid now comes from fn_mystery_bounty_inventory.

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
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_late_open boolean := false; v_ok boolean;
  v_start_chips integer := 0;
  v_seat jsonb := NULL;                                  -- LATE SEAT 2026-08-23
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_register_for_tournament requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         late_reg_levels, late_reg_mins, current_level, started_at, club_id, name, prize_pool_finalized,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount,
         start_time, authorized_to_register, is_vip_only, early_bird_enabled, early_bird_chips
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  IF v_t.status = 'RUNNING' THEN
    IF COALESCE(v_t.late_reg_levels, 0) > 0 THEN
      v_late_open := COALESCE(v_t.current_level, 0) < v_t.late_reg_levels AND NOT COALESCE(v_t.prize_pool_finalized, false);
    ELSIF COALESCE(v_t.late_reg_mins, 0) > 0 AND v_t.started_at IS NOT NULL THEN
      v_late_open := now() < v_t.started_at + make_interval(mins => v_t.late_reg_mins) AND NOT COALESCE(v_t.prize_pool_finalized, false);
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

  -- MYSTERY BOUNTY 2026-08-25: no roll here. Every bounty format, mystery
  -- included, puts the flat bounty on the head; the mystery value is drawn
  -- from a funded inventory at the knockout, not from random() at the till.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
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
      VALUES (p_tournament_id, v_uid, COALESCE(v_username,'Player'), v_start_chips, 'registered', v_head, 0, 0, 0)
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
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, v_uid);
  END IF;

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'bounty_head', CASE WHEN v_head > 0 THEN v_head END,
    'early_bird_chips', CASE WHEN v_start_chips > 0 THEN v_start_chips END,
    'late_registration', v_late_open,                    -- LATE SEAT 2026-08-23
    'seat', v_seat);                                     -- LATE SEAT 2026-08-23
END; $function$;

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

  -- MYSTERY BOUNTY 2026-08-25: no roll here. See the header, and the twin
  -- change in fn_register_for_tournament above. A horse and a human must enter
  -- the same event on the same terms; when the two functions disagreed about
  -- how a bounty head was set, they were two different tournaments.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
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
END; $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- TOURNAMENT CREATION — carry the mystery options through
-- ───────────────────────────────────────────────────────────────────────────
--
-- Section 72's options (on/off, pool split, activation mode, profile, top
-- bounty percent) are applied by this function rather than by editing
-- fn_create_tournament, which is a 15KB function this branch has no other
-- reason to touch and every reason not to rewrite from a dashboard dump.
--
-- It is called by TournamentService.createTournament immediately after the
-- create RPC returns, in the same user gesture. If it fails the tournament
-- still exists and runs on the defaults (classic profile, at-the-money
-- activation, 50/50 split), which are the settings most clubs want anyway -
-- so a failure here costs the club its customisation, never its event.

CREATE OR REPLACE FUNCTION public.fn_apply_mystery_bounty_config(
  p_tournament_id uuid,
  p_config jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid; v_stage text; v_is_mb boolean;
  v_activation text; v_profile text;
  v_value numeric; v_top numeric; v_mystery numeric; v_regular numeric;
BEGIN
  SELECT club_id, mystery_bounty_stage, is_mystery_bounty
    INTO v_club, v_stage, v_is_mb
    FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- Only the people who could have created the event can configure it, and
  -- only before the chests exist. After activation these columns describe an
  -- inventory that has already been built from them, and changing one would
  -- make the record of how the money was split a lie.
  IF v_uid IS NOT NULL AND NOT public.fn_can_create_games(v_club, v_uid)
     AND NOT public.is_club_admin(v_club, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorised');
  END IF;
  IF NOT COALESCE(v_is_mb, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_mystery_bounty');
  END IF;
  IF v_stage IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_activated');
  END IF;

  v_activation := COALESCE(p_config->>'activation', 'at_the_money');
  IF v_activation NOT IN ('at_the_money','percent_field','player_count') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_activation_mode');
  END IF;
  v_profile := COALESCE(p_config->>'profile', 'classic');
  IF v_profile NOT IN ('balanced','classic','jackpot') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_profile');
  END IF;

  v_value := (p_config->>'activationValue')::numeric;
  IF v_activation = 'percent_field' AND (COALESCE(v_value,0) <= 0 OR v_value > 100) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'activation_percent_out_of_range');
  END IF;
  IF v_activation = 'player_count' AND COALESCE(v_value,0) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'activation_count_too_small');
  END IF;

  v_top := COALESCE((p_config->>'topPercent')::numeric, 20);
  IF v_top <= 0 OR v_top > 100 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'top_percent_out_of_range');
  END IF;

  v_mystery := COALESCE((p_config->>'poolPercent')::numeric, 50);
  v_regular := COALESCE((p_config->>'regularPoolPercent')::numeric, 100 - v_mystery);
  IF v_mystery < 0 OR v_regular < 0 OR v_mystery + v_regular <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_split_invalid');
  END IF;

  UPDATE public.tournaments
     SET mystery_bounty_activation = v_activation,
         mystery_bounty_activation_value = v_value,
         mystery_bounty_profile = v_profile,
         mystery_bounty_top_percent = v_top,
         mystery_bounty_pool_percent = v_mystery,
         mystery_bounty_regular_pool_percent = v_regular
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'activation', v_activation, 'profile', v_profile,
    'activation_value', v_value, 'top_percent', v_top,
    'pool_percent', v_mystery, 'regular_pool_percent', v_regular);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_apply_mystery_bounty_config(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_apply_mystery_bounty_config(uuid, jsonb) TO authenticated, service_role;
