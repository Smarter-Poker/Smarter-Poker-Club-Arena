-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823043127 "seat_horse_skip_register_when_already_in"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6d2fc3fc1fe6cfae6a3e6d0094f3577c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Corrects fn_seat_horse_in_seat_first_game: do not re-register an entrant who
-- is already on the list.
--
-- fn_register_horse_for_tournament runs its CAPACITY check before its
-- DUPLICATE check, so calling it for a horse that is already registered in a
-- full game answers 'tournament_full' rather than 'already_registered'. The
-- seating repair therefore refused every horse it was meant to seat - caught by
-- the migration's own assertion, which rolled the whole thing back.
--
-- Registration and seating are now separate questions, asked in that order.

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
  v_already boolean;
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

  IF EXISTS (SELECT 1 FROM public.table_seats
              WHERE table_id = v_table.id AND user_id = p_user_id AND left_at IS NULL) THEN
    RETURN jsonb_build_object('ok', true, 'already_seated', true);
  END IF;

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

  -- Register ONLY if not already on the list. Asking the registration RPC about
  -- someone it has already accepted gets 'tournament_full', because its
  -- capacity check runs before its duplicate check.
  SELECT EXISTS (SELECT 1 FROM public.tournament_players
                  WHERE tournament_id = p_tournament_id AND user_id = p_user_id)
    INTO v_already;

  IF NOT v_already THEN
    v_reg := public.fn_register_horse_for_tournament(p_tournament_id, p_user_id);
    IF COALESCE((v_reg->>'ok')::boolean, false) IS NOT TRUE
       AND COALESCE(v_reg->>'reason','') <> 'already_registered' THEN
      RETURN jsonb_build_object('ok', false, 'reason', COALESCE(v_reg->>'reason','register_failed'));
    END IF;
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
    'seats_taken', v_taken, 'reused_registration', v_already,
    'seats', COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3));
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid, uuid) TO service_role;
