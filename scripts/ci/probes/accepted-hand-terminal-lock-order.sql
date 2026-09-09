-- Run as postgres against a disposable post-14534 rehearsal database with
-- dblink installed. The public accepted-hand door must wait at the shared
-- terminal root before it validates input or enters the preserved lease/table
-- implementation. NULL fixture ids deliberately move no state.
DO $accepted_hand_terminal_lock_order$
DECLARE
  v_conn text;
  v_busy integer;
  v_source text;
  v_compact_source text;
  v_root_at integer;
  v_nested_at integer;
  v_expected_refusal boolean:=false;
BEGIN
  IF current_user<>'postgres'
     OR to_regprocedure('public.dblink_connect(text,text)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)')
          IS NULL THEN
    RAISE EXCEPTION
      'accepted-hand terminal lock probe requires postgres, dblink and 14534';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid=
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure;
  v_compact_source:=regexp_replace(v_source,'[[:space:]]+','','g');
  v_root_at:=position(
    'pg_advisory_xact_lock_shared(hashtextextended(''ca:tournament-terminal-settlement:v1'',0))'
    IN v_compact_source);
  v_nested_at:=position(
    'public.fn_ca_commit_hand_settlement_exact_before_obligations('
    IN v_compact_source);
  IF v_root_at=0 OR v_nested_at=0 OR v_root_at>v_nested_at
     OR position('pg_advisory_xact_lock' IN v_compact_source)<>v_root_at THEN
    RAISE EXCEPTION
      'FAIL public accepted-hand authority does not take terminal root first';
  END IF;

  v_conn:=format(
    'host=%s port=%s dbname=%s user=%s application_name=%s',
    split_part(current_setting('unix_socket_directories'),',',1),
    current_setting('port'),current_database(),session_user,'%s');
  PERFORM public.dblink_connect(
    'accepted_hand_terminal_holder',format(v_conn,'accepted_hand_terminal_holder'));
  PERFORM public.dblink_connect(
    'accepted_hand_terminal_caller',format(v_conn,'accepted_hand_terminal_caller'));

  PERFORM public.dblink_send_query('accepted_hand_terminal_holder',$remote$
    SELECT 1 AS done
      FROM (SELECT pg_advisory_xact_lock(
              hashtextextended('ca:tournament-terminal-settlement:v1',0)),
            pg_sleep(1.2)) hold
  $remote$);
  PERFORM pg_sleep(0.15);
  PERFORM public.dblink_send_query('accepted_hand_terminal_caller',$remote$
    SELECT public.fn_ca_commit_hand_settlement(
      NULL::uuid,1000000,'[]'::jsonb,0,0,
      'accepted-hand-terminal-lock-probe',0,
      '{}'::jsonb,'[]'::jsonb,'accepted-hand-terminal-lock-probe',
      '9a000000-0000-4000-8000-000000000001'::uuid,NULL::jsonb) AS result
  $remote$);
  PERFORM pg_sleep(0.25);
  v_busy:=public.dblink_is_busy('accepted_hand_terminal_caller');
  IF v_busy<>1 THEN
    RAISE EXCEPTION
      'FAIL accepted hand validated before waiting at the terminal root';
  END IF;

  PERFORM done
    FROM public.dblink_get_result('accepted_hand_terminal_holder') AS x(done integer);
  BEGIN
    PERFORM result
      FROM public.dblink_get_result('accepted_hand_terminal_caller')
        AS x(result jsonb);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%invalid_post_commit_obligations%' THEN
      v_expected_refusal:=true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_expected_refusal THEN
    RAISE EXCEPTION
      'FAIL accepted hand did not validate immediately after terminal release';
  END IF;

  PERFORM public.dblink_disconnect('accepted_hand_terminal_caller');
  PERFORM public.dblink_disconnect('accepted_hand_terminal_holder');
  RAISE EXCEPTION
    'AUDIT_TEST_PASS: the public accepted-hand transaction waited at the shared terminal root before validation or any lease/table lock; the exclusive terminal holder completed without a lock cycle and no state moved';
EXCEPTION WHEN OTHERS THEN
  BEGIN PERFORM public.dblink_cancel_query('accepted_hand_terminal_caller');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_cancel_query('accepted_hand_terminal_holder');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('accepted_hand_terminal_caller');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('accepted_hand_terminal_holder');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RAISE;
END;
$accepted_hand_terminal_lock_order$;
