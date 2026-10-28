-- Retained actual installed owned-move component, read-only catalog capture October28.
-- MD5 pg_get_functiondef: 10e596aee2721e282dc22c0b45242a83
CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute_before_maintenance_gate(p_move_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m record; src record; dst record; v_seat integer; v_new_id uuid; v_stack numeric;
  v_hold text; v_agreed boolean;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frozen');
  END IF;
  SELECT * INTO m FROM public.cash_seat_moves WHERE id = p_move_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF m.state <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', m.state); END IF;
  IF m.expires_at <= clock_timestamp() THEN
    -- EVERY EXPIRY SAYS WHY (2026-09-09). This one is not "the engine never
    -- came" - it came, and the deadline passed between the decision and this
    -- row. Left unnamed it was indistinguishable from every other expiry.
    UPDATE public.cash_seat_moves
       SET state = 'expired', note = 'expired_before_the_executor_reached_it'
     WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF m.swap_move_id IS NOT NULL THEN
    RETURN public.fn_cash_seat_swap_execute(m.id);
  END IF;

  SELECT * INTO src FROM public.table_seats
   WHERE table_id = m.from_table_id AND user_id = m.player_id AND left_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'player_not_seated' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_seated');
  END IF;

  IF coalesce(src.stack, 0) <= 0 THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'busted' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'busted');
  END IF;

  SELECT * INTO dst FROM public.tables WHERE id = m.to_table_id FOR UPDATE;
  IF NOT FOUND OR dst.status NOT IN ('waiting', 'running', 'active') OR dst.lifecycle IN ('breaking', 'closed') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  SELECT gs INTO v_seat FROM generate_series(1, coalesce(dst.max_players, 9)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats ts
                      WHERE ts.table_id = dst.id AND ts.seat_number = gs AND ts.left_at IS NULL)
   ORDER BY gs LIMIT 1;
  IF v_seat IS NULL THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_full' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_full');
  END IF;

  v_stack := src.stack;

  v_hold := CASE WHEN m.reason = 'seat_change' THEN 'waiting' ELSE 'moved' END;
  v_agreed := (m.reason = 'seat_change');

  PERFORM set_config('app.cash_seat_move', 'on', true);

  -- PRESENCE FOLLOWS THE PLAYER (2026-09-05). is_sitting_out / sit_out_at used
  -- to be written false/NULL here, so a player sitting out at the feeder was
  -- dealt into the first hand at the new table. Carried now, with the ORIGINAL
  -- sit_out_at, so the 5-minute eviction clock is the same clock.
  BEGIN
    UPDATE public.table_seats
       SET user_id = src.user_id, member_id = src.member_id, stack = v_stack,
           is_sitting_out = coalesce(src.is_sitting_out, false), sit_out_at = src.sit_out_at,
           is_away = coalesce(src.is_away, false),
           joined_at = src.joined_at,
           horse_id = src.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = src.auto_rebuy, time_bank_remaining = src.time_bank_remaining,
           time_bank_uses_remaining = src.time_bank_uses_remaining, club_id = src.club_id,
           entry_hold = v_hold, entry_post_agreed = v_agreed, left_at = NULL
     WHERE table_id = dst.id AND seat_number = v_seat AND left_at IS NOT NULL
     RETURNING id INTO v_new_id;
    IF v_new_id IS NULL THEN
      INSERT INTO public.table_seats
        (table_id, seat_number, user_id, member_id, stack, is_sitting_out, is_away, sit_out_at, joined_at,
         horse_id, status, leave_pending, auto_rebuy, time_bank_remaining, time_bank_uses_remaining,
         club_id, entry_hold, entry_post_agreed)
      VALUES
        (dst.id, v_seat, src.user_id, src.member_id, v_stack,
         coalesce(src.is_sitting_out, false), coalesce(src.is_away, false), src.sit_out_at, src.joined_at,
         src.horse_id, 'active', false, src.auto_rebuy, src.time_bank_remaining, src.time_bank_uses_remaining,
         src.club_id, v_hold, v_agreed)
      RETURNING id INTO v_new_id;
    END IF;
    UPDATE public.table_seats SET stack = 0 WHERE id = src.id;
    UPDATE public.table_seats SET left_at = clock_timestamp(), leave_pending = false, status = 'left'
     WHERE id = src.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_seat_move', '', true);
    -- A TRANSIENT FAILURE IS NOT A REFUSAL (2026-09-07). 40P01 deadlock,
    -- 55P03 lock timeout and 40001 serialization all mean "try again", and
    -- cancelling for them also puts the player under the planner's 60 second
    -- back-off. The move stays pending; the next hand boundary retries it,
    -- bounded by its own expires_at.
    IF SQLSTATE IN ('40P01', '55P03', '40001') THEN
      UPDATE public.cash_seat_moves
         SET note = left('retry after ' || SQLSTATE || ': ' || SQLERRM, 200)
       WHERE id = m.id;
      RETURN jsonb_build_object('ok', false, 'reason', 'transient',
                                'retry', true, 'detail', left(SQLERRM, 200));
    END IF;
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;
  PERFORM set_config('app.cash_seat_move', '', true);

  /* A RE-POINT IS NOT ALLOWED TO COLLIDE (2026-09-10). This UPDATE moves
     the open session from the source table to the destination. If the
     player already holds an OPEN session on the destination - a leftover
     from an earlier stay there that was never closed - the re-point makes
     two rows with (player_id, 'table', dst) both closed_at IS NULL and
     violates cash_player_session_one_open. The whole post-hand leave_pending
     step then throws and the player does not leave. Measured 2026-09-10:
     1,091 of 4,751 seat moves in six hours had the destination already
     carrying an open session, and 34 hands in 83 minutes failed this way.
     The SOURCE session is the live one - it carries the stay clock for the
     seat being moved - so the leftover is closed and the live one re-points. */
  UPDATE public.cash_player_session
     SET closed_at = clock_timestamp(), closed_reason = 'superseded_by_move'
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = dst.id AND closed_at IS NULL;

  UPDATE public.cash_player_session
     SET scope_id = dst.id, table_id = dst.id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;

  UPDATE public.tables t SET current_players =
    (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
   WHERE t.id IN (m.from_table_id, m.to_table_id);
  UPDATE public.cash_seat_moves
     SET state = 'done', executed_at = clock_timestamp(), to_seat_number = v_seat
   WHERE id = m.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (m.game_id, m.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', m.player_id, 'from_table_id', m.from_table_id,
                             'to_seat', v_seat, 'stack', v_stack, 'reason', m.reason));

  RETURN jsonb_build_object('ok', true, 'to_table_id', m.to_table_id, 'to_seat_number', v_seat, 'stack', v_stack,
                            'reason', m.reason);
END;
$function$
