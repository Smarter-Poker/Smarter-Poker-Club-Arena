-- Cancel the game queue and its table offers as one admission.
-- Native PostgreSQL counterexample: the old function returned ok/cancelled=1
-- while a notified table offer remained live. Both browser entry points now
-- share one cancellation and the same game-row lock as fn_cash_game_join.
-- No seated occupancy, stack, wallet, or delivered history is changed.
-- Reserved by scripts/new-migration.mjs against main and remote branches.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_cash_game_leave_waitlist(uuid)'::regprocedure))
       NOT IN ('30be86e3c2d1515b9c2757b8cc48007c', 'b9ed5b782e459c7662facffafb22d4d0')
     OR md5(pg_get_functiondef('public.fn_table_waitlist_leave(uuid)'::regprocedure))
       NOT IN ('4d59d3edb0812bec2ac88b2c4b1e885f', '780c7a64408ae65d23a669343289e4f2') THEN
    RAISE EXCEPTION 'Unreviewed waitlist cancellation baseline';
  END IF;
END;
$guard$;


CREATE OR REPLACE FUNCTION public.fn_cash_game_leave_waitlist(p_game_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_n integer;
  v_offers integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first' USING ERRCODE = '28000';
  END IF;
  -- Same first lock as the game join door and cluster planner. A concurrent
  -- join cannot insert a fresh offer halfway through this cancellation.
  PERFORM 1 FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  UPDATE public.cash_game_waitlist SET status = 'cancelled', updated_at = now()
   WHERE game_id = p_game_id AND user_id = v_uid AND status IN ('waiting', 'notified');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- The game queue and its physical-table offers are one admission. Leaving
  -- must retire both or an engine can still call a player who already left.
  UPDATE public.table_waitlist w SET status = 'left', hold_expires_at = NULL
    FROM public.tables t
   WHERE t.id = w.table_id AND t.cluster_id = p_game_id
     AND w.user_id = v_uid AND w.status IN ('waiting', 'notified');
  GET DIAGNOSTICS v_offers = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'cancelled', v_n, 'released_offers', v_offers);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_table_waitlist_leave(p_table_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_n integer;
  v_game_id uuid;
  v_game_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in first' USING ERRCODE = '28000';
  END IF;
  SELECT cluster_id INTO v_game_id FROM public.tables WHERE id = p_table_id;
  IF v_game_id IS NOT NULL THEN
    v_game_result := public.fn_cash_game_leave_waitlist(v_game_id);
    RETURN jsonb_build_object('ok', true, 'cancelled', (v_game_result->>'released_offers')::integer);
  END IF;
  UPDATE public.table_waitlist SET status = 'left', hold_expires_at = NULL
   WHERE table_id = p_table_id AND user_id = v_uid AND status IN ('waiting', 'notified');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'cancelled', v_n);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cash_game_leave_waitlist(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_leave_waitlist(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_table_waitlist_leave(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_table_waitlist_leave(uuid) TO authenticated, service_role;
COMMIT;
