-- ═══════════════════════════════════════════════════════════════════════════
-- SATELLITE SEATS: make the money follow the player
-- 2026-08-23, Cowork session 11d
-- ALREADY APPLIED TO PROD via Supabase MCP as `fn_award_satellite_seat`.
--
-- processSatelliteAwards registered a seat winner into the target with a raw
-- INSERT of a tournament_players row at chips 0. That seats the player, but
-- nothing else moves: the target's prize_pool never grows, no rake row is
-- written, and the satellite's own collected pool is never disbursed to
-- anyone. The chips players paid into the satellite are simply destroyed, and
-- the target then pays out a pool that is short by one buy-in per seat.
--
-- A satellite seat must land exactly where a direct buy-in would:
--   prize_pool += target.buy_in_amount        (the prize portion)
--   total_rake += target.buy_in_fee + rake_records row   (the fee portion)
-- funded by the satellite pool, which is what the seat cost in the first
-- place (ticket = buy_in + fee). That balances to the chip.
--
-- IDEMPOTENT BY CONSTRUCTION: the pool/rake movement happens only when the
-- seat row is actually inserted. A duplicate award (recovery re-drive, retry,
-- concurrent finish) inserts nothing and moves nothing, and reports awarded
-- = false. Callers may re-drive freely.
--
-- Exposure when shipped: zero completed satellites exist, so this corrects a
-- future path rather than a past one.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_award_satellite_seat(
  p_satellite_id uuid,
  p_target_id uuid,
  p_user_id uuid,
  p_username text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t        record;
  v_name     text;
  v_seat_id  uuid;
BEGIN
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
         max_players, current_players
    INTO v_t
    FROM public.tournaments
   WHERE id = p_target_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_not_found');
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') THEN
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
      (tournament_id, user_id, username, chips, status)
    VALUES (p_target_id, p_user_id, v_name, 0, 'registered')
    RETURNING id INTO v_seat_id;
  EXCEPTION WHEN unique_violation THEN
    -- Already seated. Move nothing: the pool was credited on the first award.
    RETURN jsonb_build_object('ok', true, 'awarded', false,
                              'reason', 'already_registered');
  END;

  -- The seat is real, so the money moves with it — same split a direct
  -- buy-in would produce.
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

REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text) TO service_role;

-- POST-APPLY ASSERTIONS ─────────────────────────────────────────────────────
DO $$
DECLARE r jsonb; v_cnt integer;
BEGIN
  SELECT count(*) INTO v_cnt FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_award_satellite_seat';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'expected exactly one fn_award_satellite_seat, found %', v_cnt;
  END IF;

  SELECT public.fn_award_satellite_seat(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid, 'Probe') INTO r;
  IF (r->>'ok')::boolean IS DISTINCT FROM false
     OR r->>'reason' <> 'target_not_found' THEN
    RAISE EXCEPTION 'missing-target probe returned %', r;
  END IF;
END $$;
