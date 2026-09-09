-- Run after 20260909014433. This probe is read-only: it verifies the installed
-- root lock hierarchy, raw-DML guard, public wrapper ACLs and service-only
-- atomic assignment. The final PASS exception prevents accidental state from
-- being committed if this file is ever extended.
DO $probe$
DECLARE
  v_source text;
  v_global integer;
  v_maintenance integer;
  v_mission integer;
  v_launch integer;
  v_tournament integer;
BEGIN
  IF to_regprocedure(
       'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)') IS NULL
     OR to_regprocedure(
       'public.fn_tournament_live_seat_acquisition_requires_authority()') IS NULL THEN
    RAISE EXCEPTION 'FAIL tournament seat acquisition authority is incomplete';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)'::regprocedure;
  v_global:=position('ca:tournament-terminal-settlement:v1' IN v_source);
  v_maintenance:=position('pg_advisory_xact_lock_shared(530090,1)' IN v_source);
  v_mission:=position('public.fn_lock_daily_mission_user(p_user_id)' IN v_source);
  v_launch:=position('FROM public.tournament_launch_receipts r' IN v_source);
  v_tournament:=position('FROM public.tournaments t' IN v_source);
  IF v_global=0 OR v_maintenance<=v_global OR v_mission<=v_maintenance
     OR v_launch<=v_mission OR v_tournament<=v_launch
     OR v_source ~* 'NOWAIT|pg_try_advisory|deadlock_detected|pg_sleep'
     OR has_function_privilege(
       'service_role',
       'public.fn_ca_lock_tournament_seat_acquisition(uuid,uuid,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL tournament seat root lock order or ACL changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure;
  IF position('FROM pg_catalog.pg_locks l' IN v_source)=0
     OR position('l.pid=pg_backend_pid()' IN v_source)=0
     OR position('l.objsubid=1' IN v_source)=0
     OR position('TOURNAMENT_SEAT_ACQUISITION_REQUIRES_TERMINAL_AUTHORITY'
          IN v_source)=0
     OR v_source ~* 'pg_(try_)?advisory'
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid='public.table_seats'::regclass
          AND g.tgname='a0_tournament_live_seat_root_guard'
          AND g.tgfoid=
            'public.fn_tournament_live_seat_acquisition_requires_authority()'::regprocedure
          AND NOT g.tgisinternal AND g.tgenabled='O' AND g.tgtype=23)
     OR has_function_privilege(
       'service_role',
       'public.fn_tournament_live_seat_acquisition_requires_authority()',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL raw tournament seat acquisition guard changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid=
     'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)'::regprocedure;
  IF position('fn_ca_lock_tournament_seat_acquisition' IN v_source)=0
     OR position('INSERT INTO public.table_seats' IN v_source)=0
     OR position('UPDATE public.tournament_players tp' IN v_source)=0
     OR position('UPDATE public.tables tb' IN v_source)=0
     OR position('current_players' IN v_source)=0
     OR position('replayed' IN v_source)=0
     OR has_function_privilege(
       'anon',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL atomic tournament seat assignment changed';
  END IF;

  SELECT prosrc INTO v_source FROM pg_proc
   WHERE oid='public.fn_sync_seat_first_player_count(uuid)'::regprocedure;
  IF position('ca:tournament-terminal-settlement:v1' IN v_source)>0
     OR position('v_book := public.fn_spin_book_entry' IN v_source)=0
     OR has_function_privilege(
       'service_role','public.fn_sync_seat_first_player_count(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL AFTER-seat sync reacquired globally or was exposed';
  END IF;

  IF has_function_privilege(
       'anon','public.fn_take_seat_and_buy_in(uuid,integer)','EXECUTE')
     OR NOT has_function_privilege(
       'authenticated','public.fn_take_seat_and_buy_in(uuid,integer)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_seat_horse_in_seat_first_game(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_seat_horse_in_seat_first_game(uuid,uuid)','EXECUTE')
     OR has_function_privilege(
       'authenticated','public.fn_seat_late_registrant(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege(
       'service_role','public.fn_seat_late_registrant(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'FAIL tournament seat public wrapper ACL changed';
  END IF;

  RAISE EXCEPTION 'PASS tournament seat acquisition authority is exact';
END;
$probe$;
