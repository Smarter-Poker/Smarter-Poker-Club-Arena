-- 20260905195011_a_cash_entrant_who_wins_a_seat_is_paid_the_seat_in_cash.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 5 gate, 2026-09-05 19:5x UTC):
--
-- The escrow close judge filed escrow-close:956383d2 at 19:22: Sunday Deep
-- Stack Satellite $25 reached COMPLETED with 200.00 of prize still in escrow.
-- Read from the rows: three seats of 200.00 in Sunday $200 Deep Stack
-- (a449e853) were owed to places 1, 2 and 3. Places 1 (RiverFox) and 3
-- (xchamp) already held the target seat and were paid the ticket value in
-- cash (200.00 each, obligations settled 19:22:05 and 19:22:08). Place 2
-- (railbirdd, 11758a4f) had BOUGHT the target seat with 200.00 of their own
-- chips at 10:08:57 (wallet_transactions, tournament_buyin, a449e853); the
-- award saw an existing seat with source_satellite_id NULL, reported the
-- origin unknown, and the engine paid nothing and filed
-- Satellite.seat_origin_unknown "needs a human". The 200.00 sat in the
-- satellite's escrow.
--
-- Two things, under CLAUDE.md 10.9 (read, idempotent, nobody paid twice,
-- nothing taken back, probed rolled back, the paragraph above):
--   1. railbirdd is paid the 200.00 through fn_settle_tournament_obligation
--      under the stable place key (place 2, the same key the engine uses), so
--      a replay dedupes to nothing; the escrow debits with the credit.
--   2. fn_award_satellite_seat no longer calls a cash entrant unknown: a seat
--      with is_satellite_qualifier false was bought, no satellite seated it,
--      held_from_this_satellite is false and the engine pays the cash. NULL
--      origin stays unknown only on a seat a satellite awarded before
--      2026-08-30. The body is the live definition with that change; ACLs
--      restated in full.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

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
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer) TO service_role;

DO $$
DECLARE v_paid numeric; v_res jsonb; v_bal numeric;
BEGIN
  SELECT COALESCE(sum(amount_paid), 0) INTO v_paid FROM public.tournament_obligations
   WHERE tournament_id = '956383d2-96af-4f43-8fd2-ce6f1d9877c3' AND user_id = '11758a4f-55bc-4758-861a-bee6830c70b8';
  IF v_paid <> 0 THEN RAISE EXCEPTION 'railbirdd already paid % on this satellite; nothing to settle', v_paid; END IF;
  SELECT prize_balance INTO v_bal FROM public.tournament_escrow WHERE tournament_id = '956383d2-96af-4f43-8fd2-ce6f1d9877c3';
  IF v_bal < 200 THEN RAISE EXCEPTION 'the satellite escrow holds % , not the 200.00 read at 19:35', v_bal; END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_res := public.fn_settle_tournament_obligation(
    '956383d2-96af-4f43-8fd2-ce6f1d9877c3', 'place', 2, '11758a4f-55bc-4758-861a-bee6830c70b8', 200.00,
    'chip standard 10.9 (migration 20260905195011)',
    'Satellite seat already held (bought with own chips) - ticket value paid in cash: Sunday $200 Deep Stack', NULL);
  IF NOT COALESCE((v_res->>'ok')::boolean, false) OR COALESCE((v_res->>'paid')::numeric, 0) <> 200.00 THEN
    RAISE EXCEPTION 'settle did not pay 200.00: %', v_res;
  END IF;
  SELECT prize_balance INTO v_bal FROM public.tournament_escrow WHERE tournament_id = '956383d2-96af-4f43-8fd2-ce6f1d9877c3';
  IF abs(v_bal) > 0.005 THEN RAISE EXCEPTION 'the satellite escrow does not read zero after the payment (%)', v_bal; END IF;
  RAISE NOTICE 'railbirdd paid 200.00; satellite escrow at zero';
END $$;

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260905195011_a_cash_entrant_who_wins_a_seat_is_paid_the_seat_in_cash',
       root_cause = 'place 2 (railbirdd) had bought the target seat with 200.00 of own chips at 10:08; the award reported the seat origin unknown (source_satellite_id NULL on a cash entry) and the engine paid nothing, leaving the 200.00 seat value in the satellite escrow; places 1 and 3 in the same position were paid in cash',
       resolution = 'railbirdd paid 200.00 through fn_settle_tournament_obligation under the place-2 key; the escrow reads zero; fn_award_satellite_seat now reports a cash entrant as held_from_this_satellite false so the engine pays the cash itself'
 WHERE dedupe_key IN ('escrow-close:956383d2-96af-4f43-8fd2-ce6f1d9877c3', 'escrow:956383d2-96af-4f43-8fd2-ce6f1d9877c3') AND status = 'open';

UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       resolution = 'the winner had bought the target seat with own chips (not a satellite seat); ticket value 200.00 paid in cash under the place-2 key by migration 20260905195011; the award now reports a cash entrant as not held from this satellite'
 WHERE source = 'Satellite.seat_origin_unknown' AND context::text LIKE '%956383d2%' AND resolved_at IS NULL;

COMMIT;
