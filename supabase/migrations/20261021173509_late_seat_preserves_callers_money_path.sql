-- A late satellite target chair must restore its caller's settlement authority.
-- PR7590's bare ALTER FUNCTION SET was atomically refused by the managed
-- NOSUPERUSER installer; this reserved migration has never been applied.
-- Restore the actual caller on all six returns and on exception rethrow.
-- Original body/locks/validation/writes, ACL and enforcement remain unchanged.
-- @live-proof: md5(pg_get_functiondef('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure))='d9c1e75f047a443d7e45bec1b6e85620'
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure)) IS DISTINCT FROM '4f1800b2cd9bbf61cf926130eb8f03db'
 THEN RAISE EXCEPTION 'late_seat_context_source_changed' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'::regprocedure
  AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}') THEN
 RAISE EXCEPTION 'late_seat_context_metadata_changed' USING ERRCODE='55000'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_seat_late_registrant_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_previous_money_path text := current_setting('app.money_path',true);
  v_status text;
  v_start_chips integer;
  v_club uuid;
  v_bonus integer;
  v_chips integer;
  v_table uuid;
  v_cap int;
  v_seat int;
  v_taken int;
  v_opened boolean := false;
  v_capacity jsonb;
BEGIN
  PERFORM set_config('app.money_path', 'fn_seat_late_registrant', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  SELECT status, COALESCE(starting_chips, 0), club_id
    INTO v_status, v_start_chips, v_club
    FROM public.tournaments WHERE id = p_tournament_id;

  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    PERFORM set_config('app.money_path',COALESCE(v_previous_money_path,''),true);
    RETURN jsonb_build_object('ok', false, 'reason', 'not_running');
  END IF;

  SELECT COALESCE(chips, 0) INTO v_bonus
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND user_id = p_user_id
     AND table_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = p_tournament_id
         AND s.user_id = p_user_id
         AND s.left_at IS NULL
     )
     FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.money_path',COALESCE(v_previous_money_path,''),true);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_seated_or_missing');
  END IF;

  v_chips := v_start_chips + GREATEST(v_bonus, 0);

  SELECT tb.id, COALESCE(tb.max_players, 9)
    INTO v_table, v_cap
    FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
     AND lower(COALESCE(tb.status, '')) IN ('waiting', 'running', 'active')
     AND COALESCE(tb.is_deleted,false)=false
     AND (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) < COALESCE(tb.max_players, 9)
   ORDER BY (
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id = tb.id AND s.left_at IS NULL
     ) DESC, tb.created_at ASC
   LIMIT 1
     FOR UPDATE OF tb;

  -- Capacity owns the table format, current blinds, legal chairs and durable
  -- manager receipt. The entry already exists here, so reserve no second entry.
  IF v_table IS NULL THEN
    v_capacity := public.fn_ensure_late_registration_capacity(p_tournament_id,0);
    v_table := NULLIF(v_capacity->>'table_id','')::uuid;
    IF COALESCE((v_capacity->>'ok')::boolean,false) IS NOT TRUE
       OR v_table IS NULL THEN
      PERFORM set_config('app.money_path',COALESCE(v_previous_money_path,''),true);
      RETURN jsonb_build_object('ok',false,'reason','no_open_seat');
    END IF;
    SELECT tb.max_players INTO STRICT v_cap FROM public.tables tb
     WHERE tb.id=v_table AND tb.tournament_id=p_tournament_id
       AND tb.status IN ('waiting','running','active')
       AND COALESCE(tb.is_deleted,false)=false FOR UPDATE;
    v_opened := COALESCE((v_capacity->>'created')::boolean,false);
  END IF;

  SELECT g.n INTO v_seat
    FROM generate_series(1, v_cap) AS g(n)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.table_seats s
      WHERE s.table_id = v_table AND s.seat_number = g.n AND s.left_at IS NULL
   )
   ORDER BY g.n LIMIT 1;

  IF v_seat IS NULL THEN
    PERFORM set_config('app.money_path',COALESCE(v_previous_money_path,''),true);
    RETURN jsonb_build_object('ok', false, 'reason', 'no_open_seat');
  END IF;

  UPDATE public.table_seats
     SET user_id        = p_user_id,
         stack          = v_chips,
         left_at        = NULL,
         joined_at      = now(),
         is_sitting_out = false,
         is_away        = false,
         club_id        = COALESCE(club_id, v_club)
   WHERE table_id = v_table AND seat_number = v_seat AND left_at IS NOT NULL;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.table_seats (table_id, user_id, seat_number, stack, club_id)
      VALUES (v_table, p_user_id, v_seat, v_chips, v_club);
    EXCEPTION WHEN unique_violation THEN
      PERFORM set_config('app.money_path',COALESCE(v_previous_money_path,''),true);
      RETURN jsonb_build_object('ok', false, 'reason', 'seat_race');
    END;
  END IF;

  UPDATE public.tournament_players
     SET status      = 'playing',
         chips       = v_chips,
         table_id    = v_table,
         seat_number = v_seat
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id;

  SELECT count(*) INTO v_taken
    FROM public.table_seats WHERE table_id = v_table AND left_at IS NULL;
  UPDATE public.tables SET current_players = v_taken WHERE id = v_table;

  PERFORM set_config('app.money_path',COALESCE(v_previous_money_path,''),true);

  RETURN jsonb_build_object('ok', true, 'table_id', v_table,
    'seat_number', v_seat, 'chips', v_chips, 'opened_table', v_opened);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.money_path',COALESCE(v_previous_money_path,''),true);
  RAISE;
END;
$function$
;
COMMIT;
