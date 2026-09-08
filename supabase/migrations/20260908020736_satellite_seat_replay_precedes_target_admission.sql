-- Satellite replay identity precedes admission rules for new seats.
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'::regprocedure)) <> '05f0d7860aefe8b065ee9289e1f5d7c7' THEN
 RAISE EXCEPTION 'Satellite seat baseline changed; review before applying';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_award_satellite_seat(p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_username text DEFAULT NULL::text, p_position integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t        record;
  v_name     text;
  v_seat_id  uuid;
  v_cap      integer;
  v_existing uuid;
  v_existing_q boolean;
  v_seated   boolean;
  v_sat      record;
  v_field    integer;
  v_value    numeric;
  -- Lane G (2026-09-02): the seat is paid from the satellite's own pool.
  v_sat_pool numeric;
  v_moved    numeric := 0;
  v_short    numeric := 0;
  v_st       text;
  v_msg      text;
BEGIN
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
         max_players, current_players, current_level,
         late_reg_levels, rebuy_levels, prize_pool_finalized
    INTO v_t
    FROM public.tournaments
   WHERE id = p_target_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_not_found');
  END IF;

  -- A previously committed award is a replay even if admission later closed.
    SELECT source_satellite_id, COALESCE(is_satellite_qualifier, false)
      INTO v_existing, v_existing_q
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

  IF FOUND THEN

    /* CHIP STANDARD (2026-09-05): A CASH ENTRANT IS NOT AN UNKNOWN. A seat
       with is_satellite_qualifier false was bought with the player's own
       chips (its wallet debit is on the ledger); no satellite seated them, so
       this one certainly did not, and the ticket value is theirs in cash.
       NULL origin is unknown only on a seat a satellite awarded before
       2026-08-30. Sunday Deep Stack Satellite $25 (956383d2), 19:22 UTC: the
       second place had bought the target seat for 200.00 at 10:08 and was
       paid nothing while first and third were paid 200.00 each. */
    v_seated := CASE WHEN NOT v_existing_q THEN false
                     WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing_q AND v_existing IS NULL));
  END IF;

  -- Mirror of server/src/tournament/satelliteTargetOpen.ts, which is the
  -- authority the engine consults BEFORE calling this. The two must agree:
  -- ANNOUNCED/REGISTERING are open; RUNNING is open only inside late
  -- registration (late_reg_levels, falling back to rebuy_levels, both
  -- meaning "no late reg" when 0/NULL); everything else is closed.
  IF v_t.status IN ('ANNOUNCED', 'REGISTERING') THEN
    NULL; -- open
  ELSIF v_t.status = 'RUNNING' THEN
    v_cap := COALESCE(NULLIF(v_t.late_reg_levels, 0), NULLIF(v_t.rebuy_levels, 0), 0);
    IF v_cap <= 0 OR COALESCE(v_t.current_level, 0) >= v_cap THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
  END IF;

  -- A FINALIZED POOL IS A CLOSED DOOR (2026-08-31). fn_register_for_tournament
  -- refuses on this flag and isLateRegClosed() returns true on it regardless of
  -- level; it is the platform's single statement that the pool has stopped
  -- moving, and the payout ladder is sized against it. Adding a buy-in after it
  -- is set pays a ladder that was built without that buy-in.
  IF COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_pool_finalized');
  END IF;

  IF v_t.max_players IS NOT NULL
     AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_full');
  END IF;

  SELECT COALESCE(NULLIF(p_username, ''),
                  NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_name
    FROM public.profiles WHERE id = p_user_id;
  v_name := COALESCE(v_name, COALESCE(NULLIF(p_username, ''), 'Player'));

  BEGIN
    INSERT INTO public.tournament_players
      (tournament_id, user_id, username, chips, status,
       is_satellite_qualifier, source_satellite_id)
    VALUES (p_target_id, p_user_id, v_name, 0, 'registered', true, p_satellite_id)
    RETURNING id INTO v_seat_id;
  EXCEPTION WHEN unique_violation THEN
    -- Already seated. Move nothing - the pool was credited when the seat was
    -- first taken. But SAY WHO SEATED THEM: a re-drive of THIS satellite must
    -- stay silent, while a win in a DIFFERENT satellite deserves the ticket
    -- value in cash, and only the caller can pay it.
    --
    -- AND SAY WHEN YOU DO NOT KNOW. source_satellite_id has only been written
    -- since 2026-08-30; every seat awarded before that has it NULL. Collapsing
    -- NULL to FALSE answers "a different satellite seated them" and sends the
    -- caller down the branch that pays cash, on top of a seat this satellite
    -- may well have awarded. NULL means unknown, and the caller pays nothing.
    SELECT source_satellite_id, COALESCE(is_satellite_qualifier, false)
      INTO v_existing, v_existing_q
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

    /* CHIP STANDARD (2026-09-05): A CASH ENTRANT IS NOT AN UNKNOWN. A seat
       with is_satellite_qualifier false was bought with the player's own
       chips (its wallet debit is on the ledger); no satellite seated them, so
       this one certainly did not, and the ticket value is theirs in cash.
       NULL origin is unknown only on a seat a satellite awarded before
       2026-08-30. Sunday Deep Stack Satellite $25 (956383d2), 19:22 UTC: the
       second place had bought the target seat for 200.00 at 10:08 and was
       paid nothing while first and third were paid 200.00 each. */
    v_seated := CASE WHEN NOT v_existing_q THEN false
                     WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing_q AND v_existing IS NULL));
  END;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool      = COALESCE(prize_pool, 0) + COALESCE(v_t.buy_in_amount, 0),
         total_rake      = COALESCE(total_rake, 0) + COALESCE(v_t.buy_in_fee, 0)
   WHERE id = p_target_id;

  IF COALESCE(v_t.buy_in_fee, 0) > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_t.buy_in_fee,
            COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 1, 0,
            true, p_target_id, 'fn_award_satellite_seat',
            jsonb_build_object('kind', 'satellite_seat_entry_fee',
                               'user_id', p_user_id,
                               'satellite_id', p_satellite_id,
                               'registration_id', v_seat_id));
  END IF;

  v_value := round(COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 2);

  /* THE SEAT IS PAID FROM THE SATELLITE'S OWN POOL (Lane G, 2026-09-02).
     The target was just credited buy_in + fee. Until now nobody was debited,
     so the target owed prize money it never received and the satellite kept
     a pool it had already spent. Move the seat value out of the satellite's
     prize_pool, and write the one ledger row that says where it went.

     NEVER REFUSE, NEVER UNSEAT. A pool that cannot cover the seat (a
     guaranteed seat count the field did not fund) moves what it holds and
     files a WARNING with the shortfall; any failure inside this block leaves
     the award exactly as it was before this migration and files the same
     warning. The seat is the payout; the bookkeeping is not allowed to take
     it back. */
  BEGIN
    SELECT prize_pool INTO v_sat_pool
      FROM public.tournaments
     WHERE id = p_satellite_id
     FOR UPDATE;
    v_sat_pool := round(COALESCE(v_sat_pool, 0), 2);
    v_moved := LEAST(GREATEST(v_sat_pool, 0), v_value);
    v_short := round(v_value - v_moved, 2);

    IF v_moved > 0 THEN
      UPDATE public.tournaments
         SET prize_pool = round(COALESCE(prize_pool, 0) - v_moved, 2)
       WHERE id = p_satellite_id;

      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_satellite_id, 'tournaments.prize_pool',
         'prize_liability', p_target_id, 'tournaments.prize_pool+total_rake',
         v_moved, 'tournament_buyin', v_t.club_id, p_satellite_id,
         'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text || ':pool_transfer',
         format('Satellite seat: %s paid from the satellite pool into %s (buy-in %s + fee %s) for the seat of %s',
                v_moved, COALESCE(v_t.name, p_target_id::text),
                COALESCE(v_t.buy_in_amount, 0), COALESCE(v_t.buy_in_fee, 0), p_user_id),
         jsonb_build_object('kind', 'satellite_seat_pool_transfer',
                            'satellite_id', p_satellite_id,
                            'satellite_target_id', p_target_id,
                            'user_id', p_user_id,
                            'registration_id', v_seat_id,
                            'seat_value', v_value,
                            'moved', v_moved,
                            'unbacked', v_short),
         v_sat_pool, round(v_sat_pool - v_moved, 2))
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    END IF;

    IF v_short > 0 THEN
      PERFORM public.fn_raise_server_financial_alert(
        'warning', 'satellite_seat_unbacked',
        format('Satellite %s awarded a seat worth %s into %s but its pool held only %s: %s of that seat is a guarantee overlay nobody funded. The seat was awarded.',
               p_satellite_id, v_value, COALESCE(v_t.name, p_target_id::text), v_sat_pool, v_short),
        jsonb_build_object('kind', 'satellite_seat_unbacked',
                           'satellite_id', p_satellite_id,
                           'target_id', p_target_id,
                           'user_id', p_user_id,
                           'registration_id', v_seat_id,
                           'seat_value', v_value,
                           'satellite_pool_before', v_sat_pool,
                           'moved', v_moved,
                           'shortfall', v_short),
        'sat_unbacked:' || p_satellite_id::text || ':' || p_user_id::text);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (v_t.club_id, p_user_id, v_value, v_st,
              'fn_award_satellite_seat pool transfer (satellite ' || p_satellite_id::text
              || ' -> target ' || p_target_id::text || '): ' || v_msg);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      PERFORM public.fn_raise_server_financial_alert(
        'warning', 'satellite_seat_unbacked',
        format('Satellite %s awarded a seat worth %s into %s but the pool transfer failed (%s %s). The seat was awarded; the satellite pool was not reduced.',
               p_satellite_id, v_value, COALESCE(v_t.name, p_target_id::text), v_st, v_msg),
        jsonb_build_object('kind', 'satellite_seat_transfer_failed',
                           'satellite_id', p_satellite_id,
                           'target_id', p_target_id,
                           'user_id', p_user_id,
                           'registration_id', v_seat_id,
                           'seat_value', v_value,
                           'sqlstate', v_st, 'sqlerrm', v_msg),
        'sat_unbacked:' || p_satellite_id::text || ':' || p_user_id::text);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    v_moved := 0;
    v_short := v_value;
  END;

  /* THE SEAT IS THE PAYOUT. Same transaction, same row lock: the record
     exists if and only if the seat does. Keyed so a recovery re-drive that
     somehow reaches here writes nothing new. Failure to record must never
     unseat a player, so it is caught and raised as a money alert instead. */
  BEGIN
    SELECT tournament_type, prize_pool INTO v_sat
      FROM public.tournaments WHERE id = p_satellite_id;
    SELECT count(*) INTO v_field
      FROM public.tournament_players WHERE tournament_id = p_satellite_id;
    v_value := COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0);

    INSERT INTO public.tournament_payouts
      (tournament_id, user_id, "position", amount, source, idempotency_key,
       paid_at, tournament_type, field_size, prize_pool, recorded_by, metadata)
    VALUES
      (p_satellite_id, p_user_id, p_position, v_value, 'satellite_seat',
       'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text,
       now(), v_sat.tournament_type, v_field,
       -- The COLLECTED pool, as every earlier row recorded it: read before
       -- this seat's transfer reduced it.
       COALESCE(v_sat_pool, v_sat.prize_pool),
       'award_satellite_seat',
       jsonb_build_object('satellite_target_id', p_target_id,
                          'target_name', v_t.name,
                          'registration_id', v_seat_id,
                          'target_buy_in', COALESCE(v_t.buy_in_amount, 0),
                          'target_fee', COALESCE(v_t.buy_in_fee, 0),
                          'pool_transfer', v_moved,
                          'unbacked', v_short))
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('critical', 'satellite_seat_record',
            'A satellite seat was awarded but its payout record could not be written',
            jsonb_build_object('satellite_id', p_satellite_id,
                               'target_id', p_target_id,
                               'user_id', p_user_id,
                               'registration_id', v_seat_id,
                               'sqlstate', SQLSTATE,
                               'sqlerrm', SQLERRM));
  END;

  RETURN jsonb_build_object(
    'ok', true, 'awarded', true, 'registration_id', v_seat_id,
    'prize_contribution', COALESCE(v_t.buy_in_amount, 0),
    'rake', COALESCE(v_t.buy_in_fee, 0),
    'pool_transfer', v_moved,
    'unbacked', v_short);
END;
$function$;

-- Pin the existing production service-only permissions for clean installations.
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer) TO service_role;
