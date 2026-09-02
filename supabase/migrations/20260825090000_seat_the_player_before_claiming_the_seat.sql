-- THE ROSTER MUST NOT CLAIM A SEAT THE PLAYER NEVER GOT (2026-08-25)
--
-- fn_seat_horse_in_seat_first_game stamped tournament_players
-- (status/table_id/seat_number) and THEN inserted into table_seats. The INSERT
-- sits in a BEGIN..EXCEPTION block, which is a subtransaction, so a
-- unique_violation rolled the INSERT back and left the roster UPDATE standing.
--
-- The roster then said "seated at table X, seat N" while no seat row existed.
-- Two consequences, both measured live on 2026-08-25:
--
--   * The seat picker reads table_seats, so seat N was still free and the NEXT
--     horse was handed the SAME number. Tournament 88ef09af had all three
--     players stamped seat_number = 1 at a table holding ZERO live seats;
--     5abea362 had two players both stamped seat 2.
--   * fn_enforce_tournament_capacity counts the roster, so the game read FULL
--     and refused every new entrant, while the start gate counts live seats and
--     read SHORT and never started. Permanently wedged: 7 spins, the oldest
--     2023 minutes (33 hours) past its start time, 16 phantom claims between
--     them.
--
-- Fix: take the seat FIRST. The INSERT is the operation that can fail on a
-- race, so it is the one that must decide. Nothing touches the roster until the
-- seat is actually held.
--
-- ROLLBACK: re-apply the previous definition from
-- 20260824070000_the_occupied_table_is_the_real_table.sql, which carries the
-- UPDATE-then-INSERT ordering. fn_release_phantom_seat_claims can simply be
-- dropped; it only ever clears a claim that no seat row backs.

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t       record;
  v_table   record;
  v_seat    int;
  v_reg     jsonb;
  v_taken   int;
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
    FROM public.tables
   WHERE id = public.fn_tournament_primary_table(p_tournament_id);
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

  -- SEAT FIRST. If this races, we return before the roster has been told
  -- anything, so there is nothing to roll back and nothing left inconsistent.
  BEGIN
    INSERT INTO public.table_seats (table_id, user_id, seat_number, stack)
    VALUES (v_table.id, p_user_id, v_seat, 0);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_taken');
  END;

  -- Only now is the claim true.
  UPDATE public.tournament_players
     SET status = 'playing', table_id = v_table.id, seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  v_taken := COALESCE(public.fn_sync_seat_first_player_count(p_tournament_id), 0);

  RETURN jsonb_build_object('ok', true, 'table_id', v_table.id, 'seat_number', v_seat,
    'seats_taken', v_taken, 'reused_registration', v_already,
    'seats', COALESCE(NULLIF(v_table.max_players,0), v_t.max_players, 3));
END;
$function$;

-- REPAIR: release roster claims that point at a seat which does not exist.
--
-- Scoped to seat-first games still REGISTERING, i.e. games that have never
-- dealt a hand, so releasing a claim cannot disturb play. A player whose
-- claimed seat has no live table_seats row is simply not seated, whatever the
-- roster says, and clearing the claim is what lets the engine seat them.
CREATE OR REPLACE FUNCTION public.fn_release_phantom_seat_claims()
 RETURNS TABLE(tournament_id uuid, released int)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH phantom AS (
    SELECT tp.tournament_id, tp.user_id
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
     WHERE t.status = 'REGISTERING'
       AND (COALESCE(t.variant,'') = 'spin' OR COALESCE(t.max_players,0) <= 2)
       AND tp.table_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.table_id = tp.table_id
            AND s.user_id  = tp.user_id
            AND s.left_at IS NULL
       )
  ), cleared AS (
    UPDATE public.tournament_players tp
       SET table_id = NULL, seat_number = NULL, status = 'registered'
      FROM phantom p
     WHERE tp.tournament_id = p.tournament_id
       AND tp.user_id       = p.user_id
    RETURNING tp.tournament_id
  )
  SELECT c.tournament_id, COUNT(*)::int FROM cleared c GROUP BY c.tournament_id;
END;
$function$;
