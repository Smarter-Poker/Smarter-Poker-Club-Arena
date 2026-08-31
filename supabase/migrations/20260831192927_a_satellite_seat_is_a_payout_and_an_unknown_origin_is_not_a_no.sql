-- 2026-08-31 - MTT Phase 5: a satellite seat is a payout, and an unknown
-- origin is not a "no".
--
-- TWO THINGS, BOTH IN fn_award_satellite_seat, BOTH ABOUT EVIDENCE.
--
-- 1. THE ONE OUTCOME WORTH SOMETHING IS THE ONE WITH NO RECORD.
--
-- Every FAILURE path in processSatelliteAwards pays cash through
-- fn_credit_and_log, so Phase 3 already evidences it: target closed, seat
-- refused, seat already held, remainder to the next finisher. The SUCCESS
-- path - a player actually receiving a seat in the target - moves real value
-- (the target's prize_pool grows by a buy-in, a rake row is written) and left
-- no row in the payout record at all.
--
-- So the audit query that answers "what did this satellite award?" could see
-- every consolation prize and none of the seats. 19 seats have been awarded
-- this way.
--
-- The record is written HERE, inside the same transaction and the same row
-- lock that seats the player, so it exists if and only if the seat does. Its
-- source is `satellite_seat`, deliberately NOT one of the sources
-- fn_tournament_payout_reconcile counts: a seat is funded by the satellite's
-- collected pool buying a ticket, not by the satellite's prize_pool paying a
-- place, and counting it as structure cash would make every satellite read as
-- a massive overpay.
--
-- 2. "I CANNOT TELL WHO SEATED THEM" MUST NOT READ AS "A DIFFERENT SATELLITE".
--
-- When the seat INSERT hits unique_violation the player already holds the
-- target seat, and the caller has to choose between two very different things:
--
--   THIS satellite seated them, this is a recovery re-drive  -> pay nothing
--   ANOTHER satellite seated them, this one owes them cash   -> pay the ticket
--
-- The flag that decides it is `source_satellite_id`, which this function only
-- began writing on 2026-08-30. All 19 seats awarded before that have it NULL,
-- and the old expression
--
--     (v_existing IS NOT NULL AND v_existing = p_satellite_id)
--
-- collapses NULL to FALSE - the "a different satellite seated them" answer.
-- It is not that answer. It is "unknown", and answering an unknown with the
-- branch that MOVES MONEY is the wrong direction: a player really seated by
-- this satellite would be handed the ticket value in cash on top of the seat
-- they already hold. 13 satellites were live when this was written, so it is
-- reachable, not theoretical.
--
-- It now returns NULL for unknown, plus `origin_unknown`. The engine's check
-- is `=== false`, so NULL already falls through to the branch that pays
-- nothing - the safe direction - and the engine can now say so out loud
-- instead of logging a seat award that did not happen.
--
-- A missed payment is visible and recoverable. A double payment is neither.
--
-- CHECKED FOR DAMAGE ALREADY DONE: four players hold a satellite-won seat and
-- also took satellite cash. None is a double pay. Three were paid in the same
-- instant on 2026-08-30 by the documented back-pay migration, and the fourth
-- was paid six days BEFORE they won their seat.
--
-- TIER: 3 (money path). ROLLBACK at the bottom.

BEGIN;

SET LOCAL lock_timeout = '8s';

-- The payout record gains a place for facts that are not a payout structure.
-- A seat award needs to name the target it was awarded into and the
-- registration row it created; putting either in `payout_structure` would make
-- that column mean two different things.
ALTER TABLE public.tournament_payouts
  ADD COLUMN IF NOT EXISTS metadata jsonb;

COMMENT ON COLUMN public.tournament_payouts.metadata IS
  'Facts about this payout that are not the payout structure. Used by satellite seat awards to name the target tournament and the registration row created there.';

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
  v_seated   boolean;
  v_sat      record;
  v_field    integer;
  v_value    numeric;
BEGIN
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
         max_players, current_players, current_level,
         late_reg_levels, rebuy_levels
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
    IF v_cap <= 0 OR COALESCE(v_t.current_level, 0) > v_cap THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
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
    SELECT source_satellite_id INTO v_existing
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

    v_seated := CASE WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing IS NULL));
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
       now(), v_sat.tournament_type, v_field, v_sat.prize_pool,
       'award_satellite_seat',
       jsonb_build_object('satellite_target_id', p_target_id,
                          'target_name', v_t.name,
                          'registration_id', v_seat_id,
                          'target_buy_in', COALESCE(v_t.buy_in_amount, 0),
                          'target_fee', COALESCE(v_t.buy_in_fee, 0)))
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
    'rake', COALESCE(v_t.buy_in_fee, 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ===========================================================================
-- PROVEN, NOT ASSERTED (probe inside a rolled-back transaction, per §11.5):
--   award    = {"ok": true, "awarded": true, "prize_contribution": 200.00, "rake": 20.00}
--   pool     0 -> 200.00 on the target
--   record   = src=satellite_seat amt=220.00 pos=1 recby=award_satellite_seat
--   re-drive = {"awarded": false, "held_from_this_satellite": true,  "origin_unknown": false}
--   unknown  = {"awarded": false, "held_from_this_satellite": null,  "origin_unknown": true}
--   records  = 1  (the re-drives wrote nothing)
-- ===========================================================================
-- ROLLBACK
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer);
-- -- then re-apply the four-argument body from the migration that last defined it
-- ALTER TABLE public.tournament_payouts DROP COLUMN IF EXISTS metadata;
-- COMMIT;
