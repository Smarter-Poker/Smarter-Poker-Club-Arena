-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823042905 "horses_take_seats_in_seat_first_games"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 62f2b8171356d4f50e48b64e9457465e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- See supabase/migrations/20260823090000_horses_take_seats_in_seat_first_games.sql
-- (Club Arena) for the full rationale.

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(
  p_tournament_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_t     record;
  v_table record;
  v_seat  int;
  v_reg   jsonb;
  v_taken int;
BEGIN
  SELECT id, status, variant, max_players, name
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF NOT (COALESCE(v_t.variant,'') = 'spin' OR COALESCE(v_t.max_players,0) <= 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_seat_first_game');
  END IF;

  SELECT id, max_players INTO v_table
    FROM public.tables WHERE tournament_id = p_tournament_id
    ORDER BY created_at LIMIT 1;
  IF v_table.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_table');
  END IF;

  -- Already seated is success, not a race to retry.
  IF EXISTS (SELECT 1 FROM public.table_seats
              WHERE table_id = v_table.id AND user_id = p_user_id AND left_at IS NULL) THEN
    RETURN jsonb_build_object('ok', true, 'already_seated', true);
  END IF;

  -- Lowest free seat, so a part-filled table reads left to right.
  SELECT s INTO v_seat
    FROM generate_series(1, COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3)) s
   WHERE NOT EXISTS (
     SELECT 1 FROM public.table_seats ts
      WHERE ts.table_id = v_table.id AND ts.seat_number = s AND ts.left_at IS NULL
   )
   ORDER BY s LIMIT 1;

  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_full');
  END IF;

  -- Register first. The registration RPC owns the capacity and duplicate
  -- checks, and the BEFORE INSERT capacity trigger is the final word.
  v_reg := public.fn_register_horse_for_tournament(p_tournament_id, p_user_id);
  IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
     AND COALESCE(v_reg->>'reason','') <> 'already_registered' THEN
    RETURN jsonb_build_object('ok', false, 'reason', COALESCE(v_reg->>'reason','register_failed'));
  END IF;

  UPDATE public.tournament_players
     SET status = 'playing', table_id = v_table.id, seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  BEGIN
    INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
    VALUES (v_table.id, p_user_id, v_seat, 0);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  END;

  SELECT count(*) INTO v_taken FROM public.table_seats
   WHERE table_id = v_table.id AND left_at IS NULL;
  UPDATE public.tables SET current_players = v_taken WHERE id = v_table.id;

  RETURN jsonb_build_object('ok', true, 'table_id', v_table.id, 'seat_number', v_seat,
    'seats_taken', v_taken, 'seats', COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3));
END;
$fn$;

COMMENT ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid) IS
  'Puts a horse in an actual SEAT of a Spin or heads-up table, not just on the registration list. fn_register_horse_for_tournament only writes tournament_players, and a seat-first game starts when every SEAT is sold - so a topped-up Spin looked full on paper, showed three empty seats, could never start, and sold a fourth entry to the next human who sat down.';

REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_seat_horse_in_seat_first_game') THEN
    RAISE EXCEPTION 'fn_seat_horse_in_seat_first_game was not created';
  END IF;
  IF has_function_privilege('anon', 'public.fn_seat_horse_in_seat_first_game(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'seating horses must not be reachable by a client role';
  END IF;
END $$;
