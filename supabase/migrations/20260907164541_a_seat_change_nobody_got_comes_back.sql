-- 20260907164541_a_seat_change_nobody_got_comes_back.sql
--
-- A SEAT CHANGE NOBODY GOT COMES BACK.
--
-- Dan's rule is that every player gets one table change per game. The door
-- enforces it (fn_cash_seat_change_request raises SEAT_CHANGE_USED), and the
-- allowance is spent the moment the request is MADE, not when the move lands.
--
-- fn_cash_seat_change_cancel already knows what to do when a request ends
-- without a move. It says so in its own comment:
--
--     -- The button comes back.
--     UPDATE public.cash_game_roster SET seat_change_used_at = NULL ...
--
-- fn_cash_seat_change_plan cancels a request for the same reason - the player
-- is no longer in the chair they asked from - and did not give it back. Same
-- event, same meaning, one line missing. The player is still in the game, was
-- never moved by their own request, and had no change left.
--
-- Measured on production before this was written: 7 requests cancelled with
-- note 'left_table', and 2 players on an OPEN roster row with
-- seat_change_used_at set and no 'moved' request anywhere. Those two are
-- restored by the backfill at the end, and the migration asserts none is left.
--
-- Why the player is usually out of that chair: the cluster moved them. A
-- must-move promotion or a balance move takes the seat they asked from, which
-- makes their voluntary request meaningless - but a change the system made for
-- its own reasons is not the change they asked for, so it must not consume the
-- one they are owed.
--
-- 'left_game' is untouched: that path closes the roster row, and a rejoin
-- opens a fresh one with a fresh allowance.
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_change_plan(p_game_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; p record;
  v_census public.cash_cluster_census_row[];
  v_target uuid;
  v_moves integer := 0;
  v_move_a uuid; v_move_b uuid;
  v_seat_a integer; v_seat_b integer;
BEGIN
  v_census := public.fn_cash_cluster_census(p_game_id, p_now);

  FOR r IN SELECT q.* FROM public.cash_seat_change_requests q
            WHERE q.game_id = p_game_id AND q.status = 'requested'
            ORDER BY q.created_at, q.id
  LOOP
    -- Still in that chair, with chips, not on the way out?
    IF NOT EXISTS (SELECT 1 FROM public.table_seats ts
                    WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL) THEN
      UPDATE public.cash_seat_change_requests
         SET status = 'cancelled', resolved_at = p_now, note = 'left_table'
       WHERE id = r.id;
      -- AND THE BUTTON COMES BACK. This request is being cancelled for a
      -- reason that is not the player's doing and did not move them where they
      -- asked, so it must not spend the one change they get for this game.
      -- fn_cash_seat_change_cancel has done exactly this for the player's own
      -- cancel since day one; this is the same event arriving from the planner.
      UPDATE public.cash_game_roster
         SET seat_change_used_at = NULL
       WHERE game_id = p_game_id AND user_id = r.user_id AND left_at IS NULL;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, r.from_table_id, 'seat_change_returned',
              jsonb_build_object('player_id', r.user_id, 'reason', 'left_table'));
      CONTINUE;
    END IF;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                               WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL
                                 AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false);
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = r.user_id AND m.state = 'pending');
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.cash_seat_moves m
                           WHERE m.player_id = r.user_id AND m.state = 'cancelled' AND m.created_at > p_now - interval '60 seconds');

    -- A chair: the table they asked for, or (any) the shortest other table
    -- that is not Main 1 and not closing.
    SELECT c.id INTO v_target FROM unnest(v_census) c
     WHERE c.id <> r.from_table_id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
       AND NOT (c.role = 'main' AND c.main_index = 1)
       AND (r.to_table_id IS NULL OR c.id = r.to_table_id)
       AND c.open_unreserved
           - (SELECT count(*) FROM public.cash_seat_moves m
               WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) > 0
     ORDER BY c.seated ASC, c.created_at ASC LIMIT 1;
    IF v_target IS NOT NULL THEN
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (p_game_id, r.user_id, r.from_table_id, v_target, 'seat_change')
      RETURNING id INTO v_move_a;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_a, note = 'seat_open'
       WHERE id = r.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, v_target, 'move_planned',
              jsonb_build_object('player_id', r.user_id, 'from_table_id', r.from_table_id, 'reason', 'seat_change'));
      v_moves := v_moves + 1;
      CONTINUE;
    END IF;

    -- A swap: the oldest other request whose table I would take and who
    -- would take mine. Both chairs are occupied, so both moves are linked
    -- and land together (fn_cash_seat_swap_execute).
    SELECT q.*, ts.seat_number AS their_seat INTO p
      FROM public.cash_seat_change_requests q
      JOIN unnest(v_census) c ON c.id = q.from_table_id
      JOIN public.table_seats ts ON ts.table_id = q.from_table_id AND ts.user_id = q.user_id AND ts.left_at IS NULL
     WHERE q.game_id = p_game_id AND q.status = 'requested' AND q.id <> r.id
       AND q.from_table_id <> r.from_table_id
       AND (r.to_table_id IS NULL OR q.from_table_id = r.to_table_id)
       AND (q.to_table_id IS NULL OR q.to_table_id = r.from_table_id)
       AND NOT c.breaking AND c.lifecycle = 'live'
       AND NOT (c.role = 'main' AND c.main_index = 1)
       AND coalesce(ts.stack, 0) > 0 AND coalesce(ts.leave_pending, false) = false
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = q.user_id AND m.state = 'pending')
       AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m
                        WHERE m.player_id = q.user_id AND m.state = 'cancelled' AND m.created_at > p_now - interval '60 seconds')
     ORDER BY q.created_at, q.id LIMIT 1;
    IF FOUND THEN
      SELECT ts.seat_number INTO v_seat_a FROM public.table_seats ts
       WHERE ts.table_id = r.from_table_id AND ts.user_id = r.user_id AND ts.left_at IS NULL;
      v_seat_b := p.their_seat;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number)
      VALUES (p_game_id, r.user_id, r.from_table_id, p.from_table_id, 'seat_change', v_seat_b)
      RETURNING id INTO v_move_a;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason, to_seat_number, swap_move_id)
      VALUES (p_game_id, p.user_id, p.from_table_id, r.from_table_id, 'seat_change', v_seat_a, v_move_a)
      RETURNING id INTO v_move_b;
      UPDATE public.cash_seat_moves SET swap_move_id = v_move_b WHERE id = v_move_a;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_a, note = 'swap'
       WHERE id = r.id;
      UPDATE public.cash_seat_change_requests
         SET status = 'moved', resolved_at = p_now, move_id = v_move_b, note = 'swap'
       WHERE id = p.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (p_game_id, p.from_table_id, 'swap_planned',
              jsonb_build_object('player_id', r.user_id, 'with_player_id', p.user_id,
                                 'from_table_id', r.from_table_id, 'to_table_id', p.from_table_id));
      v_moves := v_moves + 2;
    END IF;
  END LOOP;
  RETURN v_moves;
END;
$function$;

-- CREATE OR REPLACE keeps the grants the function already had, so production
-- was never opened up by the statement above: it is {postgres, service_role}
-- and no browser role can reach it. Restating them is for the NEXT database
-- this file is replayed into, where a bare CREATE takes Postgres's default and
-- hands EXECUTE to PUBLIC - which is anon. This planner is controller-internal:
-- fn_cash_cluster_tick calls it, nobody in a browser ever should, and it writes
-- seat moves without asking who is calling. GRANT/REVOKE fire no schema-cache
-- reload, so it costs nothing.
REVOKE ALL ON FUNCTION public.fn_cash_seat_change_plan(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_change_plan(uuid, timestamptz) TO service_role;

-- The players who already lost theirs.
WITH restored AS (
  UPDATE public.cash_game_roster r
     SET seat_change_used_at = NULL
   WHERE r.left_at IS NULL
     AND r.seat_change_used_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.cash_seat_change_requests s
                  WHERE s.game_id = r.game_id AND s.user_id = r.user_id
                    AND s.status = 'cancelled' AND s.note = 'left_table')
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_change_requests s2
                      WHERE s2.game_id = r.game_id AND s2.user_id = r.user_id AND s2.status = 'moved')
  RETURNING r.game_id, r.user_id
)
INSERT INTO public.cash_cluster_events (game_id, kind, payload)
SELECT game_id, 'seat_change_returned',
       jsonb_build_object('player_id', user_id, 'reason', 'backfill_left_table')
  FROM restored;

DO $assert$
DECLARE v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.cash_game_roster r
   WHERE r.left_at IS NULL AND r.seat_change_used_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.cash_seat_change_requests s
                  WHERE s.game_id = r.game_id AND s.user_id = r.user_id
                    AND s.status = 'cancelled' AND s.note = 'left_table')
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_change_requests s2
                      WHERE s2.game_id = r.game_id AND s2.user_id = r.user_id AND s2.status = 'moved');
  IF v_left <> 0 THEN
    RAISE EXCEPTION '% player(s) still hold a spent seat change they never received', v_left;
  END IF;
END $assert$;

COMMIT;
