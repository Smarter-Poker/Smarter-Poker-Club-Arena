-- Run as postgres against a disposable stage-one rehearsal database with
-- dblink installed. It proves that still-callable rolling component and live
-- bounty RPCs wait behind the exact transaction lock acquired by the terminal
-- wrapper before either path can own a row.
DO $lock_order_probe$
DECLARE
  v_conn text;
  v_busy integer;
  v_result jsonb;
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure('public.dblink_connect(text,text)') IS NULL
     OR to_regprocedure(
       'public.fn_complete_tournament_terminal(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION
      'atomic terminal rolling lock probe requires postgres, dblink and stage one';
  END IF;
  v_conn := format(
    'host=%s port=%s dbname=%s user=%s',
    split_part(current_setting('unix_socket_directories'),',',1),
    current_setting('port'),current_database(),session_user);

  PERFORM public.dblink_connect('terminal_holder',v_conn);
  PERFORM public.dblink_connect('rolling_caller',v_conn);

  -- The holder models the first executable statement of the wrapper. The
  -- migration source guard pins that wrapper to this exact key.
  PERFORM public.dblink_send_query('terminal_holder',$remote$
    SELECT 1 AS done
      FROM (SELECT pg_advisory_xact_lock(
              hashtextextended('ca:tournament-terminal-settlement:v1',0)),
            pg_sleep(1.2)) hold
  $remote$);
  PERFORM pg_sleep(0.15);
  PERFORM public.dblink_send_query('rolling_caller',$remote$
    SELECT public.fn_settle_tournament_rake(
      NULL::uuid,'atomic-terminal-lock-probe') AS result
  $remote$);
  PERFORM pg_sleep(0.25);
  v_busy := public.dblink_is_busy('rolling_caller');
  IF v_busy <> 1 THEN
    RAISE EXCEPTION
      'FAIL rolling rake component did not wait behind terminal lock';
  END IF;
  PERFORM done FROM public.dblink_get_result('terminal_holder') AS x(done integer);
  SELECT result INTO v_result
    FROM public.dblink_get_result('rolling_caller') AS x(result jsonb);
  IF v_result->>'reason' <> 'not_found' THEN
    RAISE EXCEPTION 'FAIL rolling rake lock probe returned %',v_result;
  END IF;

  -- A libpq async connection retains its final command result until the next
  -- get_result call. Reconnect so the second independent interleaving starts
  -- with no protocol state from the first one.
  PERFORM public.dblink_disconnect('rolling_caller');
  PERFORM public.dblink_disconnect('terminal_holder');
  PERFORM public.dblink_connect('terminal_holder',v_conn);
  PERFORM public.dblink_connect('rolling_caller',v_conn);

  -- fn_collect_bounty validates its parties only after taking the same lock.
  -- NULL inputs move no money and make this a pure concurrency observation.
  PERFORM public.dblink_send_query('terminal_holder',$remote$
    SELECT 1 AS done
      FROM (SELECT pg_advisory_xact_lock(
              hashtextextended('ca:tournament-terminal-settlement:v1',0)),
            pg_sleep(1.2)) hold
  $remote$);
  PERFORM pg_sleep(0.15);
  PERFORM public.dblink_send_query('rolling_caller',$remote$
    SELECT public.fn_collect_bounty(
      NULL::uuid,NULL::uuid,NULL::uuid,NULL::jsonb) AS result
  $remote$);
  PERFORM pg_sleep(0.25);
  v_busy := public.dblink_is_busy('rolling_caller');
  IF v_busy <> 1 THEN
    RAISE EXCEPTION
      'FAIL live bounty authority did not wait behind terminal lock';
  END IF;
  PERFORM done FROM public.dblink_get_result('terminal_holder') AS x(done integer);
  SELECT result INTO v_result
    FROM public.dblink_get_result('rolling_caller') AS x(result jsonb);
  IF v_result->>'reason' <> 'missing_party' THEN
    RAISE EXCEPTION 'FAIL live bounty lock probe returned %',v_result;
  END IF;

  PERFORM public.dblink_disconnect('rolling_caller');
  PERFORM public.dblink_disconnect('terminal_holder');
  PERFORM public.dblink_connect('terminal_holder',v_conn);
  PERFORM public.dblink_connect('rolling_caller',v_conn);

  -- The 20260908032050 legacy satellite-seat rewrite lands after the atomic
  -- satellite migration. The terminal migration wraps that final body while
  -- preserving its target-before-source row order. NULL ids move no state.
  PERFORM public.dblink_send_query('terminal_holder',$remote$
    SELECT 1 AS done
      FROM (SELECT pg_advisory_xact_lock(
              hashtextextended('ca:tournament-terminal-settlement:v1',0)),
            pg_sleep(1.2)) hold
  $remote$);
  PERFORM pg_sleep(0.15);
  PERFORM public.dblink_send_query('rolling_caller',$remote$
    SELECT public.fn_award_satellite_seat(
      NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::integer) AS result
  $remote$);
  PERFORM pg_sleep(0.25);
  v_busy := public.dblink_is_busy('rolling_caller');
  IF v_busy <> 1 THEN
    RAISE EXCEPTION
      'FAIL rolling satellite award did not wait behind terminal lock';
  END IF;
  PERFORM done FROM public.dblink_get_result('terminal_holder') AS x(done integer);
  SELECT result INTO v_result
    FROM public.dblink_get_result('rolling_caller') AS x(result jsonb);
  IF v_result->>'reason' <> 'target_not_found' THEN
    RAISE EXCEPTION 'FAIL rolling satellite award lock probe returned %',v_result;
  END IF;

  PERFORM public.dblink_disconnect('rolling_caller');
  PERFORM public.dblink_disconnect('terminal_holder');
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: a rolling direct rake component, live multi-claimant bounty authority and later legacy satellite-seat rewrite all waited behind the terminal wrapper transaction lock before any row lock; no money or fixture state moved';
END;
$lock_order_probe$;
