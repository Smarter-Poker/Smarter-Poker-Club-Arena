-- Run as postgres against a disposable stage-one rehearsal database with
-- dblink installed. The resolver must wait for the exact first transaction
-- lock used by both terminal authorities before it can classify an outcome.
-- NULL ids are deliberate: they move no state and prove validation happens
-- only after serialization.
DO $satellite_outcome_wait_probe$
DECLARE
  v_conn text;
  v_busy integer;
  v_expected_refusal boolean := false;
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure('public.dblink_connect(text,text)') IS NULL
     OR to_regprocedure(
       'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION
      'satellite outcome wait probe requires postgres, dblink and stage one';
  END IF;
  v_conn := format(
    'host=%s port=%s dbname=%s user=%s',
    split_part(current_setting('unix_socket_directories'),',',1),
    current_setting('port'),current_database(),session_user);

  PERFORM public.dblink_connect('satellite_terminal_holder',v_conn);
  PERFORM public.dblink_connect('satellite_outcome_reader',v_conn);
  PERFORM public.dblink_send_query('satellite_terminal_holder',$remote$
    SELECT 1 AS done
      FROM (SELECT pg_advisory_xact_lock(
              hashtextextended('ca:tournament-terminal-settlement:v1',0)),
            pg_sleep(1.2)) hold
  $remote$);
  PERFORM pg_sleep(0.15);
  PERFORM public.dblink_send_query('satellite_outcome_reader',$remote$
    SELECT public.fn_resolve_satellite_settlement_outcome(
      NULL::uuid,NULL::uuid) AS result
  $remote$);
  PERFORM pg_sleep(0.25);
  v_busy := public.dblink_is_busy('satellite_outcome_reader');
  IF v_busy <> 1 THEN
    RAISE EXCEPTION
      'FAIL satellite outcome resolver validated before the terminal lock';
  END IF;

  PERFORM done
    FROM public.dblink_get_result('satellite_terminal_holder') AS x(done integer);
  BEGIN
    PERFORM result
      FROM public.dblink_get_result('satellite_outcome_reader') AS x(result jsonb);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%satellite outcome requires tournament and observed winner ids%' THEN
      v_expected_refusal := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_expected_refusal THEN
    RAISE EXCEPTION
      'FAIL satellite outcome resolver did not validate immediately after waiting';
  END IF;

  PERFORM public.dblink_disconnect('satellite_outcome_reader');
  PERFORM public.dblink_disconnect('satellite_terminal_holder');
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: the satellite outcome resolver waited behind the shared terminal transaction lock before validating a no-state request; direct fixture proof separately covers definitive RUNNING and exact committed receipt results';
END;
$satellite_outcome_wait_probe$;
