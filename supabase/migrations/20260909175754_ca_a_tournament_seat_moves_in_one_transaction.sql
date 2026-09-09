/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT SEAT MOVES IN ONE TRANSACTION, OR IT DOES NOT MOVE
 *  2026-09-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS. TournamentManager.executePlayerMoves moved a player with
 * four separate round trips: read the source stack, stamp `left_at` on the
 * source seat, write the destination seat, and - if that last write failed -
 * a fifth to put `left_at` back. Between trips two and three the player holds
 * no seat at all, and their chips are off the felt.
 *
 * That window was not theoretical. On 2026-09-09 it held 1,673,900 play chips
 * across 24 players in 12 running events. The destination write was refused
 * (four-table limit, fixed in ca_a_chair_change_is_not_a_fifth_game), and the
 * compensating restore was refused as well - a broken table is closed by then
 * and ab_refuse_live_seat_on_closed_tournament_table will not revive a seat
 * on it. Neither refusal was error-checked, so the engine logged a successful
 * rollback that never happened.
 *
 * A COMPENSATING WRITE IS NOT A ROLLBACK. It is a second write that can fail
 * on its own, and when it does there is nothing left to compensate with. The
 * fix is not a better compensation - it is to stop needing one. Everything
 * below happens in ONE transaction, so a refusal at any step unwinds the
 * whole move and the player keeps the chair they were already sitting in.
 * There is no window, so nothing can arrive in it.
 *
 * IT IS ALSO THE REPAIR. A player already stranded holds no live seat, so the
 * source is taken from their most recently vacated chair instead. Bringing
 * them back is therefore the SAME primitive as moving them, not a second
 * code path that has to be kept in step with this one - and not a sweep on a
 * timer: it is called, it is not scheduled.
 *
 * CONSERVATION IS ASSERTED, NOT ASSUMED. The stack that arrives is compared
 * to the stack that left, in the same transaction, and a mismatch raises.
 */

CREATE OR REPLACE FUNCTION public.fn_ca_move_tournament_seat(
  p_tournament_id uuid,
  p_user_id       uuid,
  p_to_table_id   uuid,
  p_to_seat       integer,
  p_reason        text DEFAULT 'balance'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status       text;
  v_dest_status  text;
  v_dest_deleted boolean;
  v_dest_tourney uuid;
  v_dest_max     int;
  v_live_count   int;
  v_src          record;
  v_occupant     record;
  v_stack        numeric;
  v_landed       numeric;
  v_seat_id      uuid;
  v_from_table   uuid;
  v_from_seat    int;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_to_table_id IS NULL OR p_to_seat IS NULL THEN
    RAISE EXCEPTION 'CA_MOVE_ARGS: tournament, user, destination table and seat are all required'
      USING ERRCODE = '22023';
  END IF;

  /* One mover at a time per player per event. Two engines planning the same
     repair is a designed-for case (planOrphanReseats is deterministic); this
     makes the second one a no-op replay instead of a race. */
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca_seat_move:' || p_tournament_id::text || ':' || p_user_id::text, 0));

  SELECT upper(t.status::text) INTO v_status FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'CA_MOVE_NO_TOURNAMENT: %', p_tournament_id USING ERRCODE = '23503';
  END IF;
  IF v_status NOT IN ('REGISTERING', 'RUNNING') THEN
    RAISE EXCEPTION 'CA_MOVE_EVENT_NOT_PLAYABLE: tournament % is % - seats are not moved in a finished event',
      p_tournament_id, v_status USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_players p
     WHERE p.tournament_id = p_tournament_id AND p.user_id = p_user_id
       AND p.status IN ('registered', 'playing')
  ) THEN
    RAISE EXCEPTION 'CA_MOVE_NO_ROSTER: user % is not an active entrant in %', p_user_id, p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  SELECT lower(tb.status::text), COALESCE(tb.is_deleted, false), tb.tournament_id, COALESCE(tb.max_players, 9)
    INTO v_dest_status, v_dest_deleted, v_dest_tourney, v_dest_max
    FROM public.tables tb WHERE tb.id = p_to_table_id FOR SHARE;

  IF v_dest_tourney IS NULL THEN
    RAISE EXCEPTION 'CA_MOVE_NO_DEST_TABLE: %', p_to_table_id USING ERRCODE = '23503';
  END IF;
  IF v_dest_tourney IS DISTINCT FROM p_tournament_id THEN
    RAISE EXCEPTION 'CA_MOVE_WRONG_EVENT: table % belongs to tournament %, not %',
      p_to_table_id, v_dest_tourney, p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF v_dest_status = 'closed' OR v_dest_deleted THEN
    RAISE EXCEPTION 'CA_MOVE_DEST_CLOSED: table % cannot take a live seat', p_to_table_id
      USING ERRCODE = '23514';
  END IF;
  IF p_to_seat < 1 OR p_to_seat > v_dest_max THEN
    RAISE EXCEPTION 'CA_MOVE_DEST_SEAT_RANGE: seat % is outside 1..% on table %',
      p_to_seat, v_dest_max, p_to_table_id USING ERRCODE = '23514';
  END IF;

  /* ALREADY THERE. A replay is a success, not a second move. */
  IF EXISTS (
    SELECT 1 FROM public.table_seats s
     WHERE s.table_id = p_to_table_id AND s.seat_number = p_to_seat
       AND s.user_id = p_user_id AND s.left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('moved', false, 'replayed', true, 'reason', 'already seated there');
  END IF;

  SELECT count(*) INTO v_live_count
    FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id AND s.user_id = p_user_id AND s.left_at IS NULL;

  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'CA_MOVE_AMBIGUOUS_SOURCE: user % holds % live seats in tournament % - which stack is real is a money decision and not this mover''s to make',
      p_user_id, v_live_count, p_tournament_id USING ERRCODE = '23514';
  END IF;

  /* THE SOURCE. A live chair if they have one; otherwise the chair they were
     last seen in, which is where a stranded player's chips are sitting. */
  SELECT s.id, s.table_id, s.seat_number, s.stack, s.left_at
    INTO v_src
    FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id AND s.user_id = p_user_id
   ORDER BY (s.left_at IS NULL) DESC, s.left_at DESC NULLS FIRST
   LIMIT 1
   FOR UPDATE OF s;

  IF v_src.id IS NULL THEN
    RAISE EXCEPTION 'CA_MOVE_NO_SOURCE_SEAT: user % has never held a chair in tournament % - seating them is an entry, not a move',
      p_user_id, p_tournament_id USING ERRCODE = '23514';
  END IF;

  v_stack      := COALESCE(v_src.stack, 0);
  v_from_table := v_src.table_id;
  v_from_seat  := v_src.seat_number;

  IF v_stack <= 0 THEN
    RAISE EXCEPTION 'CA_MOVE_NO_STACK: user % carries % chips out of table % - a chairless zero stack belongs to the elimination path, not the mover',
      p_user_id, v_stack, v_from_table USING ERRCODE = '23514';
  END IF;

  /* THE DESTINATION CHAIR. table_seats keeps one row per (table, seat), so a
     seat with history is reused by UPDATE and only a never-occupied seat is
     inserted. A live occupant is somebody else's chair: refuse and let the
     caller pick another rather than overwrite them. */
  SELECT s.id, s.user_id, s.left_at INTO v_occupant
    FROM public.table_seats s
   WHERE s.table_id = p_to_table_id AND s.seat_number = p_to_seat
   FOR UPDATE;

  IF v_occupant.id IS NOT NULL AND v_occupant.left_at IS NULL THEN
    RAISE EXCEPTION 'CA_MOVE_DEST_OCCUPIED: table % seat % is held by %',
      p_to_table_id, p_to_seat, v_occupant.user_id USING ERRCODE = '23505';
  END IF;

  /* Vacate the source BEFORE the destination is made live, so the one-live-
     seat-per-tournament rule never sees two. Same transaction, so the two are
     one event: if anything below raises, this never happened either. */
  IF v_src.left_at IS NULL THEN
    UPDATE public.table_seats SET left_at = now() WHERE id = v_src.id;
  END IF;

  IF v_occupant.id IS NOT NULL THEN
    UPDATE public.table_seats
       SET user_id = p_user_id, stack = v_stack, left_at = NULL,
           joined_at = now(), is_sitting_out = false
     WHERE id = v_occupant.id
     RETURNING id, stack INTO v_seat_id, v_landed;
  ELSE
    INSERT INTO public.table_seats (table_id, user_id, seat_number, stack, joined_at, is_sitting_out)
    VALUES (p_to_table_id, p_user_id, p_to_seat, v_stack, now(), false)
    RETURNING id, stack INTO v_seat_id, v_landed;
  END IF;

  IF v_seat_id IS NULL THEN
    RAISE EXCEPTION 'CA_MOVE_DEST_NOT_WRITTEN: no destination row for % at table % seat %',
      p_user_id, p_to_table_id, p_to_seat USING ERRCODE = '23514';
  END IF;

  /* CONSERVATION. The chips that arrived must be the chips that left. */
  IF COALESCE(v_landed, -1) IS DISTINCT FROM v_stack THEN
    RAISE EXCEPTION 'CA_MOVE_STACK_CHANGED: % left table % and % arrived at table % - a move creates and destroys nothing',
      v_stack, v_from_table, v_landed, p_to_table_id USING ERRCODE = '23514';
  END IF;

  UPDATE public.tournament_players
     SET table_id = p_to_table_id, seat_number = p_to_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  /* The chair we took may still be pointed at by whoever sat in it last. */
  UPDATE public.tournament_players
     SET table_id = NULL, seat_number = NULL
   WHERE tournament_id = p_tournament_id
     AND table_id = p_to_table_id AND seat_number = p_to_seat
     AND user_id <> p_user_id;

  RETURN jsonb_build_object(
    'moved', true,
    'replayed', false,
    'user_id', p_user_id,
    'tournament_id', p_tournament_id,
    'from_table_id', v_from_table,
    'from_seat', v_from_seat,
    'from_was_live', (v_src.left_at IS NULL),
    'to_table_id', p_to_table_id,
    'to_seat', p_to_seat,
    'seat_id', v_seat_id,
    'stack', v_stack,
    'reason', COALESCE(p_reason, 'balance')
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_move_tournament_seat(uuid, uuid, uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_move_tournament_seat(uuid, uuid, uuid, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_move_tournament_seat(uuid, uuid, uuid, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_move_tournament_seat(uuid, uuid, uuid, integer, text) TO service_role;
