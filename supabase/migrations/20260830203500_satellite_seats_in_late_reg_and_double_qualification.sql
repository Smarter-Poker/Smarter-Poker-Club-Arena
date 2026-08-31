-- ═══════════════════════════════════════════════════════════════════════════
-- SATELLITE AWARDS: SEATS IN LATE REG, AND A SECOND WIN IS NEVER WORTH ZERO
-- 2026-08-30 (Claude/Cowork satellite audit)
-- APPLIED TO PRODUCTION 2026-08-30 ~20:35 UTC via Supabase MCP
-- (migration name: satellite_seats_in_late_reg_and_double_qualification).
-- This file is the auditable repo copy.
--
-- Two findings, one function:
--
-- 1. WIRING GAP left by PR #1935. The TypeScript gate
--    (isSatelliteTargetOpen) treats a RUNNING target inside late
--    registration as open, but fn_award_satellite_seat still refused every
--    status except ANNOUNCED/REGISTERING. So the exact case #1935 was built
--    for — a satellite that ends after its target started — got
--    'target_closed' from this function and fell to the cash path anyway.
--    It only worked on 2026-08-30 because the target happened to be reset
--    to REGISTERING minutes before the satellite settled.
--
-- 2. DOUBLE QUALIFICATION PAID NOTHING. On unique_violation the function
--    returned ok=true/awarded=false and the engine treated that as full
--    success. A player who won seats in two satellites received one seat
--    and nothing at all for the second win. Four such wins were back-paid
--    at ticket value (200), idempotently, in the applied migration. The
--    function now reports WHICH satellite seated the player
--    (held_from_this_satellite), so the engine can distinguish a recovery
--    re-drive (pay nothing again) from a cross-satellite double win (pay
--    ticket value in cash).

ALTER TABLE public.tournament_players
  ADD COLUMN IF NOT EXISTS source_satellite_id uuid;

CREATE OR REPLACE FUNCTION public.fn_award_satellite_seat(
  p_satellite_id uuid, p_target_id uuid, p_user_id uuid,
  p_username text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_t        record;
  v_name     text;
  v_seat_id  uuid;
  v_cap      integer;
  v_existing uuid;
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
    -- Already seated. Move nothing — the pool was credited when the seat was
    -- first taken. But SAY WHO SEATED THEM: a re-drive of THIS satellite must
    -- stay silent, while a win in a DIFFERENT satellite deserves the ticket
    -- value in cash, and only the caller can pay it.
    SELECT source_satellite_id INTO v_existing
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;
    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite',
      (v_existing IS NOT NULL AND v_existing = p_satellite_id));
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

  RETURN jsonb_build_object(
    'ok', true, 'awarded', true, 'registration_id', v_seat_id,
    'prize_contribution', COALESCE(v_t.buy_in_amount, 0),
    'rake', COALESCE(v_t.buy_in_fee, 0));
END;
$function$;

-- The applied migration also performed a one-time, idempotent data repair
-- (guarded by fn_credit_and_log idempotency keys — safe if re-run):
--   * back-paid 200 (ticket value) to the four winners who had received
--     neither seat nor cash:
--       1a6f53a4 place 1 (4e5a0000…), acb14548 place 4 (660d14dc…),
--       e3d3bd1e place 1 (650f193e…), e3d3bd1e place 5 (…000010)
--     under keys tourney:{sat}:prize:place:{pos};
--   * stamped prize = 200 on the e3d3bd1e seat winners whose prize update
--     had silently failed during the 2026-08-30 Supabase degradation.

-- Engine-only: SECURITY DEFINER and it moves money. No browser role may
-- execute it (applied to production as fn_award_satellite_seat_service_role_only).
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text) TO service_role;
