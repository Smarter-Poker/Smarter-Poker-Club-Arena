-- Read-only production export for the disposable permissions test; never applied to production.
CREATE OR REPLACE FUNCTION public.fn_admin_kick_player(p_table_id uuid, p_user_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_club    uuid;
  v_tourn   uuid;
  v_seat_no integer;
  v_seat_id uuid;
  v_res     jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_admin_kick_player requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT club_id, tournament_id INTO v_club, v_tourn FROM public.tables WHERE id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF NOT public.is_club_admin(v_club) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  SELECT id, seat_number INTO v_seat_id, v_seat_no
    FROM public.table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_seated');
  END IF;

  /* CHIP CONTINUITY H2 (2026-09-04): ONE cash-out path. This body used to
     stamp left_at and credit the wallet itself (a third implementation, and
     one a club owner could aim at their own seat to skip the stay clock).
     The authority marker below is transaction-local and is the only thing
     that lets a browser-originated call through atomic_seat_cashout_locked
     as a forced exit; it is set only after is_club_admin() passed. */
  PERFORM set_config('app.cash_exit_authority', 'club_admin', true);
  IF v_tourn IS NULL THEN
    PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', p_table_id);
  END IF;

  BEGIN
    v_res := public.atomic_seat_cashout_locked(p_user_id, p_table_id, v_seat_no, 'forced');
  EXCEPTION WHEN others THEN
    -- The marker must not outlive the kick, even on the failure path.
    PERFORM set_config('app.cash_exit_authority', '', true);
    RAISE;
  END;
  -- The marker is transaction-local and one PostgREST request is one call,
  -- but a definer that calls this function and then something else in the
  -- same transaction must not inherit a kick's authority.
  PERFORM set_config('app.cash_exit_authority', '', true);

  IF COALESCE(v_res->>'reason', '') = 'no_active_seat' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_seated');
  END IF;

  RETURN jsonb_build_object('ok', true,
    'refunded', COALESCE((v_res->>'stack')::numeric, 0),
    'seat_id', v_seat_id,
    'reason_text', p_reason);
END;
$function$;
