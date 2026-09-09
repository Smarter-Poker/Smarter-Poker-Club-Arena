/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SEAT MOVER TAKES THE TERMINAL AUTHORITY LIKE EVERY OTHER SEAT DOOR
 *  2026-09-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `one_relationship_between_seats_and_tables_the_invariants_become_triggers`
 * armed fn_tournament_live_seat_acquisition_requires_authority: a transaction
 * may only bring a tournament seat to life while it holds the global advisory
 * lock ca:tournament-terminal-settlement:v1. Its hint says "use a canonical
 * tournament seat purchase, registration, MOVE, or assignment RPC".
 *
 * fn_ca_move_tournament_seat is that move RPC and it was not taking the lock,
 * so every move it attempted was refused 55000. Measured at 22:31 UTC: 73
 * players holding 6,126,000 chips seated at no table across 8 running events,
 * and the conservation check at -6,201,000. The guard was right; this door
 * had simply not been told about it yet.
 *
 * fn_ca_lock_tournament_seat_acquisition is the sanctioned way in. It takes
 * the terminal-settlement lock and the shared entry lock, honours the
 * maintenance freeze, locks the daily-mission row, the launch receipt and the
 * tournament, and answers whether the event may be seated at all. Taking the
 * global lock FIRST and the per-player lock second keeps a consistent order
 * with every other seat door, so this cannot deadlock against them.
 *
 * A refusal from that helper is returned rather than raised: a frozen
 * platform or a finished event is not a fault in the move, and a caller
 * retrying on the next cycle is the correct behaviour. Everything else in
 * this function is unchanged - the move is still one transaction, still
 * asserts that the chips that arrived are the chips that left, and still
 * unwinds whole on any refusal.
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
  v_auth         jsonb;
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

  /* THE TERMINAL AUTHORITY, FIRST. Global lock before the per-player lock, so
     this door orders its locks the same way every other seat door does. */
  v_auth := public.fn_ca_lock_tournament_seat_acquisition(
              p_tournament_id, p_to_table_id, p_user_id);
  IF COALESCE((v_auth->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'moved', false, 'replayed', false,
      'refused', COALESCE(v_auth->>'reason', 'seat_authority_refused'),
      'authority', v_auth);
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

  SELECT s.id, s.user_id, s.left_at INTO v_occupant
    FROM public.table_seats s
   WHERE s.table_id = p_to_table_id AND s.seat_number = p_to_seat
   FOR UPDATE;

  IF v_occupant.id IS NOT NULL AND v_occupant.left_at IS NULL THEN
    RAISE EXCEPTION 'CA_MOVE_DEST_OCCUPIED: table % seat % is held by %',
      p_to_table_id, p_to_seat, v_occupant.user_id USING ERRCODE = '23505';
  END IF;

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
