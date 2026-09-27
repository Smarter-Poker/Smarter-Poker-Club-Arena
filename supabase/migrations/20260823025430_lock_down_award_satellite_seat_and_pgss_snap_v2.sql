-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823025430 "lock_down_award_satellite_seat_and_pgss_snap_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1427c163480360d7cb39c2c531fbe53f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Two live findings from economy_invariants(), which went from 0 failing to 2
-- within the hour. Neither came from the Tournament Director work; both are
-- recent additions that shipped without their grants locked down.
--
-- 1. fn_award_satellite_seat  (anon_mutating_definer_functions_check_auth_uid)
--
--    SECURITY DEFINER, EXECUTE granted to anon, takes p_user_id as a
--    PARAMETER, and performs no auth.uid() check at all. It inserts a
--    tournament_players row seating that user, adds buy_in_amount to
--    tournaments.prize_pool, adds buy_in_fee to total_rake, and writes a
--    rake_records row.
--
--    So an unauthenticated caller could seat ANY user into ANY tournament in
--    'ANNOUNCED' or 'REGISTERING' state, free, repeatedly - inflating the
--    prize pool and the rake ledger while doing it. Free entries plus
--    corrupted financial records.
--
--    Nothing calls it yet: no reference in any of the seven repos and no other
--    database function mentions it. It is wiring not yet connected, which is
--    why this closes with no risk to a live flow.
--
--    FIX, deliberately minimal so it cannot break the caller that is coming:
--      - REVOKE from anon. An anonymous request awarding a tournament seat is
--        indefensible under any design.
--      - KEEP authenticated, plus an auth.uid() guard so an authenticated user
--        can only award a seat to THEMSELVES. A client-side caller still works;
--        awarding to an arbitrary user id does not.
--      - service_role unaffected (auth.uid() is NULL there), so a server-side
--        award to any player still works. That is the path a satellite
--        completion should take.
--
--    The signature is reproduced EXACTLY, including
--    `p_username text DEFAULT NULL::text` - CREATE OR REPLACE cannot drop a
--    parameter default.
--
-- 2. _pgss_snap  (no_rls_off_tables_writable_by_clients)
--
--    A pg_stat_statements snapshot table (1 MB, 4 columns) created with RLS
--    off and default anon/authenticated grants, so clients could INSERT and
--    UPDATE performance-monitoring data.
--
-- ROLLBACK
--   GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid,uuid,uuid,text) TO anon;
--   -- and delete the guard block marked below
--   GRANT ALL ON TABLE public._pgss_snap TO anon, authenticated;
--   ALTER TABLE public._pgss_snap DISABLE ROW LEVEL SECURITY;
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_award_satellite_seat(
  p_satellite_id uuid,
  p_target_id uuid,
  p_user_id uuid,
  p_username text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_t        record;
  v_name     text;
  v_seat_id  uuid;
BEGIN
  -- ── Caller may only award a seat to THEMSELVES ──────────────────────────
  -- auth.uid() is NULL for service_role - the trusted server path, which may
  -- award to any player. For a real end-user session it must match the user
  -- being seated. Without this, p_user_id was whatever the caller typed.
  -- anon no longer holds EXECUTE at all.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_your_seat');
  END IF;

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

  -- The seat is real, so the money moves with it - same split a direct
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

-- CREATE OR REPLACE resets grants to the default set, so revoke AFTER it.
REVOKE EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text) TO authenticated, service_role;

-- ── 2. _pgss_snap ──────────────────────────────────────────────────────────
REVOKE ALL ON TABLE public._pgss_snap FROM PUBLIC;
REVOKE ALL ON TABLE public._pgss_snap FROM anon;
REVOKE ALL ON TABLE public._pgss_snap FROM authenticated;
ALTER TABLE public._pgss_snap ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public._pgss_snap IS
  'pg_stat_statements snapshots. service_role only - locked down 2026-08-22 after it tripped no_rls_off_tables_writable_by_clients.';

-- ── Assertions ─────────────────────────────────────────────────────────────
DO $$
DECLARE bad int;
BEGIN
  IF has_function_privilege('anon', 'public.fn_award_satellite_seat(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute fn_award_satellite_seat';
  END IF;
  IF has_table_privilege('anon', 'public._pgss_snap', 'INSERT')
     OR has_table_privilege('authenticated', 'public._pgss_snap', 'INSERT') THEN
    RAISE EXCEPTION 'clients can still write _pgss_snap';
  END IF;

  SELECT count(*) INTO bad FROM public.economy_invariants() WHERE NOT ok;
  IF bad > 0 THEN
    RAISE EXCEPTION 'economy_invariants still failing: % check(s)', bad;
  END IF;
  RAISE NOTICE 'economy_invariants all green';
END $$;
