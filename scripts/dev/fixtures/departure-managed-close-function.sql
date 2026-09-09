-- Pinned read-only production definition; authorization helper is a fixture boundary.
CREATE OR REPLACE FUNCTION public.fn_close_managed_game(p_kind text, p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_status text;
  v_cluster uuid;
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_kind = 'table' THEN
    SELECT club_id, status, cluster_id, role
      INTO v_club, v_status, v_cluster, v_role
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF lower(COALESCE(v_status, '')) IN ('closed', 'completed', 'cancelled', 'finished') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    PERFORM 1
      FROM public.table_seats ts
     WHERE ts.table_id = p_game_id
       AND ts.left_at IS NULL
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_seated');
    END IF;

    UPDATE public.tables
       SET status = 'closed', current_players = 0, updated_at = now()
     WHERE id = p_game_id;

    IF v_cluster IS NOT NULL AND v_role = 'main' THEN
      UPDATE public.cash_games
         SET enabled = false,
             state = 'dormant',
             closed_at = now(),
             closed_by = v_uid,
             updated_at = now()
       WHERE id = v_cluster
         AND enabled;
    END IF;
    RETURN jsonb_build_object('ok', true);
  ELSIF p_kind = 'tournament' THEN
    SELECT club_id, status
      INTO v_club, v_status
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF upper(COALESCE(v_status, '')) IN ('COMPLETED', 'CANCELLED', 'CANCELED', 'COMPLETING') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    PERFORM 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_game_id
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_registered');
    END IF;

    UPDATE public.tournaments
       SET status = 'CANCELLED', ended_at = now(), updated_at = now()
     WHERE id = p_game_id;
    UPDATE public.tables
       SET status = 'closed', current_players = 0
     WHERE tournament_id = p_game_id;
    RETURN jsonb_build_object('ok', true);
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
END;
$function$
;
