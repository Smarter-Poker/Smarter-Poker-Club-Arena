-- ═══════════════════════════════════════════════════════════════════════════
-- AN OWNER MAY START EARLY. AN OWNER MAY NOT CANCEL BY ACCIDENT.
-- (2026-08-27, create-flow audit Phase 3)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The "Start Tournament" button called TournamentService.startTournament, a
-- client-side reimplementation of the engine's start. It was wrong in four
-- ways that all reached production:
--
--   1. IT CANCELLED TOURNAMENTS. With fewer than 3 registered it flipped the
--      row to CANCELLED and refunded the field — the exact behaviour the
--      "TOURNAMENTS RUN. THEY DO NOT CANCEL." rule exists to prevent. The
--      button was then disabled below 3 players to hide that, which also
--      removed the one case an owner would most want: starting a short field.
--   2. IT BUILT TABLES THE ENGINE CANNOT SEE. It inserted `status = 'RUNNING'`
--      (uppercase). Every adoption query matches lowercase
--      ('running','waiting'), so those tables were orphaned: players sat at
--      them and no engine was ever attached.
--   3. IT IGNORED THE DECK. Hardcoded 9 seats and 'nlh', with no
--      clampSeatsForVariant — the PLO5/PLO6 over-seating deadlock that #782
--      fixed, reopened through a second door.
--   4. IT SKIPPED EVERY START GUARD: paid-seat verification, the spin
--      multiplier draw, guarantee application, table adoption, engine
--      attachment, blind timer arming.
--
-- The engine already starts a tournament the moment `start_time` has passed
-- and the minimum field is present, and tops up with horses rather than
-- cancelling when it is short. So "start early" does not need a second start
-- path — it needs the start time moved. That is all this function does. Every
-- guard above then applies for free, and there is no way for it to cancel
-- anything or create a table.
--
-- ROLLBACK: DROP FUNCTION public.fn_owner_start_tournament_now(uuid);
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_owner_start_tournament_now(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_t    record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT id, club_id, status, start_time, current_players, min_players
    INTO v_t
    FROM tournaments
   WHERE id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  -- Same authority that creates games for this club creates them early.
  IF NOT public.fn_can_create_games(v_t.club_id, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorised');
  END IF;

  IF v_t.status NOT IN ('REGISTERING', 'ANNOUNCED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_startable',
                              'status', v_t.status);
  END IF;

  -- Already due: the discovery loop owns it, and moving the time again would
  -- only look like the button did nothing.
  IF v_t.start_time IS NOT NULL AND v_t.start_time <= now() THEN
    RETURN jsonb_build_object('ok', true, 'already_due', true,
                              'start_time', v_t.start_time);
  END IF;

  UPDATE tournaments
     SET start_time = now()
   WHERE id = p_tournament_id;

  -- Deliberately NOT setting status. The engine performs the REGISTERING ->
  -- RUNNING transition itself, with the paid-seat check and the spin draw
  -- attached to it. A status written here would race that.
  RETURN jsonb_build_object(
    'ok', true,
    'already_due', false,
    'start_time', now(),
    'current_players', COALESCE(v_t.current_players, 0),
    'min_players', COALESCE(v_t.min_players, 3)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_owner_start_tournament_now(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_owner_start_tournament_now(uuid) TO authenticated, service_role;

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'fn_owner_start_tournament_now'
  ) THEN
    RAISE EXCEPTION 'owner_start_early: function was not created';
  END IF;
  -- It must never be able to cancel: no CANCELLED anywhere in the body.
  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'fn_owner_start_tournament_now'
       AND prosrc ILIKE '%CANCELLED%'
  ) THEN
    RAISE EXCEPTION 'owner_start_early: body must never cancel a tournament';
  END IF;
END $$;
