CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute(p_move_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_cash_seat_move_execute_before_maintenance_gate(p_move_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_moves_pending(p_table_id uuid)
 RETURNS TABLE(move_id uuid, player_id uuid, to_table_id uuid, to_table_name text, to_role text, to_main_index integer, reason text, announced_at timestamp with time zone, swap_move_id uuid, ready_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT m.id, m.player_id, m.to_table_id, t.name, t.role, t.main_index, m.reason, m.announced_at,
         m.swap_move_id, m.ready_at
    FROM public.cash_seat_moves m
    JOIN public.tables t ON t.id = m.to_table_id
   WHERE m.from_table_id = p_table_id AND m.state = 'pending' AND m.expires_at > clock_timestamp()
   ORDER BY m.created_at;
$function$;

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
    UPDATE public.cash_seat_moves SET state = 'expired' WHERE id = m.id;
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_announce(p_move_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n integer;
BEGIN
  -- The engine has just promised "Moving After This Hand". The promise has
  -- to outlive the hand: five minutes covers any hand the engine's own
  -- watchdog would let run.
  UPDATE public.cash_seat_moves
     SET announced_at = coalesce(announced_at, clock_timestamp()),
         expires_at   = GREATEST(expires_at, clock_timestamp() + interval '5 minutes')
   WHERE id = ANY(p_move_ids) AND state = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_swap_execute(p_move_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;
  RETURN public.fn_cash_seat_swap_execute_before_maintenance_gate(p_move_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_swap_execute_before_maintenance_gate(p_move_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m record; pm record; a record; b record; ta record; tb record;
  v_stack_a numeric; v_stack_b numeric; v_now timestamptz := clock_timestamp();
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frozen');
  END IF;
  PERFORM 1 FROM public.cash_seat_moves
   WHERE id IN (p_move_id, (SELECT swap_move_id FROM public.cash_seat_moves WHERE id = p_move_id))
   ORDER BY id FOR UPDATE;
  SELECT * INTO m FROM public.cash_seat_moves WHERE id = p_move_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF m.state <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', m.state); END IF;
  SELECT * INTO pm FROM public.cash_seat_moves WHERE id = m.swap_move_id;
  IF NOT FOUND OR pm.state <> 'pending' OR pm.expires_at <= v_now OR m.expires_at <= v_now THEN
    UPDATE public.cash_seat_moves SET state = CASE WHEN m.expires_at <= v_now THEN 'expired' ELSE 'cancelled' END,
           note = 'swap_partner_gone'
     WHERE id = m.id;
    IF pm.id IS NOT NULL AND pm.state = 'pending' THEN
      UPDATE public.cash_seat_moves SET state = 'expired', note = 'swap_partner_gone' WHERE id = pm.id;
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'swap_partner_gone');
  END IF;

  SELECT * INTO a FROM public.table_seats
   WHERE table_id = m.from_table_id AND user_id = m.player_id AND left_at IS NULL FOR UPDATE;
  SELECT * INTO b FROM public.table_seats
   WHERE table_id = pm.from_table_id AND user_id = pm.player_id AND left_at IS NULL FOR UPDATE;
  IF a.id IS NULL OR b.id IS NULL OR coalesce(a.stack, 0) <= 0 OR coalesce(b.stack, 0) <= 0 THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled',
           note = CASE WHEN a.id IS NULL THEN 'player_not_seated' WHEN coalesce(a.stack, 0) <= 0 THEN 'busted' ELSE 'swap_partner_gone' END
     WHERE id = m.id;
    UPDATE public.cash_seat_moves SET state = 'cancelled',
           note = CASE WHEN b.id IS NULL THEN 'player_not_seated' WHEN coalesce(b.stack, 0) <= 0 THEN 'busted' ELSE 'swap_partner_gone' END
     WHERE id = pm.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'swap_cancelled');
  END IF;
  SELECT * INTO ta FROM public.tables WHERE id = m.to_table_id;
  SELECT * INTO tb FROM public.tables WHERE id = pm.to_table_id;
  IF ta.lifecycle IN ('breaking', 'closed') OR tb.lifecycle IN ('breaking', 'closed') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id IN (m.id, pm.id);
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  IF m.ready_at IS NULL THEN
    UPDATE public.cash_seat_moves SET ready_at = v_now WHERE id = m.id;
  END IF;
  IF pm.ready_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'waiting_partner', 'held', true,
                              'to_table_id', m.to_table_id, 'partner_id', pm.player_id);
  END IF;

  -- Each side carries its OWN sit-out across, for the reason written on
  -- fn_cash_seat_move_execute: neither player asked to be dealt into a hand
  -- they had sat out of.
  v_stack_a := a.stack; v_stack_b := b.stack;
  PERFORM set_config('app.cash_seat_move', 'on', true);
  BEGIN
    UPDATE public.table_seats SET stack = 0 WHERE id IN (a.id, b.id);
    UPDATE public.table_seats SET left_at = v_now, leave_pending = false, status = 'left' WHERE id IN (a.id, b.id);
    UPDATE public.table_seats
       SET user_id = a.user_id, member_id = a.member_id, stack = v_stack_a,
           is_sitting_out = coalesce(a.is_sitting_out, false), sit_out_at = a.sit_out_at,
           is_away = coalesce(a.is_away, false),
           joined_at = a.joined_at, horse_id = a.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = a.auto_rebuy, time_bank_remaining = a.time_bank_remaining,
           time_bank_uses_remaining = a.time_bank_uses_remaining, club_id = a.club_id,
           entry_hold = 'waiting', entry_post_agreed = true, left_at = NULL
     WHERE id = b.id;
    UPDATE public.table_seats
       SET user_id = b.user_id, member_id = b.member_id, stack = v_stack_b,
           is_sitting_out = coalesce(b.is_sitting_out, false), sit_out_at = b.sit_out_at,
           is_away = coalesce(b.is_away, false),
           joined_at = b.joined_at, horse_id = b.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = b.auto_rebuy, time_bank_remaining = b.time_bank_remaining,
           time_bank_uses_remaining = b.time_bank_uses_remaining, club_id = b.club_id,
           entry_hold = 'waiting', entry_post_agreed = true, left_at = NULL
     WHERE id = a.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_seat_move', '', true);
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id IN (m.id, pm.id);
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;
  PERFORM set_config('app.cash_seat_move', '', true);

  UPDATE public.cash_player_session SET scope_id = m.to_table_id, table_id = m.to_table_id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;
  UPDATE public.cash_player_session SET scope_id = pm.to_table_id, table_id = pm.to_table_id
   WHERE player_id = pm.player_id AND scope_type = 'table' AND scope_id = pm.from_table_id AND closed_at IS NULL;

  UPDATE public.cash_seat_moves SET state = 'done', executed_at = v_now, to_seat_number = b.seat_number WHERE id = m.id;
  UPDATE public.cash_seat_moves SET state = 'done', executed_at = v_now, to_seat_number = a.seat_number WHERE id = pm.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (m.game_id, m.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', m.player_id, 'from_table_id', m.from_table_id, 'to_seat', b.seat_number,
                             'stack', v_stack_a, 'reason', 'seat_change', 'swap', true)),
         (pm.game_id, pm.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', pm.player_id, 'from_table_id', pm.from_table_id, 'to_seat', a.seat_number,
                             'stack', v_stack_b, 'reason', 'seat_change', 'swap', true));
  RETURN jsonb_build_object('ok', true, 'swap', true, 'to_table_id', m.to_table_id, 'to_seat_number', b.seat_number,
                            'stack', v_stack_a,
                            'partner', jsonb_build_object('player_id', pm.player_id, 'from_table_id', pm.from_table_id,
                                                          'to_table_id', pm.to_table_id, 'to_seat_number', a.seat_number,
                                                          'stack', v_stack_b));
END;
$function$;
