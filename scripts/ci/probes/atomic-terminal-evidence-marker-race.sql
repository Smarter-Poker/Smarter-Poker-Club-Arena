-- Run as postgres only on a disposable stage-one rehearsal database with
-- dblink installed. Two writers start before a terminal child marker commits,
-- wait on the child tuples, and must still reject from the newest OLD rows.
-- Fixture setup and cleanup use session_replication_role solely to construct
-- and remove an impossible pre-marker terminal shape; the holder and both
-- queued writers run with every production trigger enabled.
DO $terminal_marker_race$
DECLARE
  v_conn text;
  v_holder_sleeping boolean := false;
  v_busy_update integer;
  v_busy_delete integer;
  v_blocked_waiters integer := 0;
  v_holder_rows integer;
  v_state text;
  v_update_refused boolean := false;
  v_delete_refused boolean := false;
  v_total integer;
  v_marked integer;
  v_pristine integer;
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure('public.dblink_connect(text,text)') IS NULL
     OR to_regprocedure(
       'public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)')
          IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid) THEN
    RAISE EXCEPTION
      'terminal evidence marker race probe requires postgres, dblink and the disposable stage-one rehearsal database';
  END IF;

  v_conn := format(
    'host=%s port=%s dbname=%s user=%s',
    split_part(current_setting('unix_socket_directories'),',',1),
    current_setting('port'),current_database(),session_user);

  PERFORM public.dblink_connect('terminal_marker_setup',v_conn);
  PERFORM public.dblink_exec('terminal_marker_setup','BEGIN');
  PERFORM public.dblink_exec(
    'terminal_marker_setup','SET LOCAL session_replication_role = replica');
  PERFORM public.dblink_exec('terminal_marker_setup',$setup$
    DELETE FROM public.rake_records
     WHERE id IN (
       '8d000000-0000-0000-0000-000000000011'::uuid,
       '8d000000-0000-0000-0000-000000000012'::uuid)
  $setup$);
  PERFORM public.dblink_exec('terminal_marker_setup',$setup$
    DELETE FROM public.tournaments
     WHERE id='8d000000-0000-0000-0000-000000000001'::uuid
  $setup$);
  PERFORM public.dblink_exec('terminal_marker_setup',$setup$
    INSERT INTO public.tournaments
    SELECT (jsonb_populate_record(NULL::public.tournaments,
      to_jsonb(t) || jsonb_build_object(
        'id','8d000000-0000-0000-0000-000000000001',
        'name','Terminal Evidence Marker Race Probe',
        'status','COMPLETED',
        'ended_at','2026-09-08T15:33:29+00:00',
        'current_players',0,
        'on_break',false,
        'break_started_at',NULL,
        'break_ends_at',NULL,
        'prize_pool_finalized',true,
        'updated_at',now()
      ))).*
      FROM public.tournaments t
     WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid
  $setup$);
  PERFORM public.dblink_exec('terminal_marker_setup',$setup$
    INSERT INTO public.rake_records
      (id,club_id,rake_amount,is_tournament,tournament_id,source,metadata)
    VALUES
      ('8d000000-0000-0000-0000-000000000011',
       '20000000-0000-0000-0000-000000000001',1,true,
       '8d000000-0000-0000-0000-000000000001',
       'terminal_marker_race_probe','{"probe":"queued_update"}'::jsonb),
      ('8d000000-0000-0000-0000-000000000012',
       '20000000-0000-0000-0000-000000000001',1,true,
       '8d000000-0000-0000-0000-000000000001',
       'terminal_marker_race_probe','{"probe":"queued_delete"}'::jsonb)
  $setup$);
  PERFORM public.dblink_exec('terminal_marker_setup','COMMIT');
  PERFORM public.dblink_disconnect('terminal_marker_setup');

  PERFORM public.dblink_connect(
    'terminal_marker_holder',v_conn || ' application_name=terminal_marker_holder');
  PERFORM public.dblink_connect(
    'terminal_marker_update',v_conn || ' application_name=terminal_marker_update');
  PERFORM public.dblink_connect(
    'terminal_marker_delete',v_conn || ' application_name=terminal_marker_delete');

  -- The data-changing CTE commits both marker transitions only after its sleep.
  -- Seeing PgSleep proves both tuples are already owned before either waiter is
  -- dispatched; this is not a timing-only concurrency assertion.
  PERFORM public.dblink_send_query('terminal_marker_holder',$holder$
    WITH stamped AS MATERIALIZED (
      UPDATE public.rake_records r
         SET terminal_closed_at=t.ended_at
        FROM public.tournaments t
       WHERE r.id IN (
               '8d000000-0000-0000-0000-000000000011'::uuid,
               '8d000000-0000-0000-0000-000000000012'::uuid)
         AND t.id=r.tournament_id
         AND r.terminal_closed_at IS NULL
      RETURNING r.id
    ), held AS MATERIALIZED (
      SELECT count(*)::integer AS rows_stamped,pg_sleep(1.5)
        FROM stamped
    )
    SELECT rows_stamped FROM held
  $holder$);

  FOR v_total IN 1..40 LOOP
    SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity a
       WHERE a.datname=current_database()
         AND a.application_name='terminal_marker_holder'
         AND a.wait_event='PgSleep')
      INTO v_holder_sleeping;
    EXIT WHEN v_holder_sleeping;
    PERFORM pg_sleep(0.05);
  END LOOP;
  IF NOT v_holder_sleeping THEN
    RAISE EXCEPTION 'FAIL marker holder never reached its post-stamp lock hold';
  END IF;

  PERFORM public.dblink_send_query('terminal_marker_update',$waiter$
    UPDATE public.rake_records
       SET metadata=metadata || '{"forged":"queued_update"}'::jsonb
     WHERE id='8d000000-0000-0000-0000-000000000011'::uuid
    RETURNING id
  $waiter$);
  PERFORM public.dblink_send_query('terminal_marker_delete',$waiter$
    DELETE FROM public.rake_records
     WHERE id='8d000000-0000-0000-0000-000000000012'::uuid
    RETURNING id
  $waiter$);
  FOR v_total IN 1..20 LOOP
    SELECT count(*)::integer INTO v_blocked_waiters
      FROM pg_stat_activity a
     WHERE a.datname=current_database()
       AND a.application_name IN
           ('terminal_marker_update','terminal_marker_delete')
       AND a.wait_event_type='Lock';
    EXIT WHEN v_blocked_waiters=2;
    PERFORM pg_sleep(0.02);
  END LOOP;
  v_busy_update:=public.dblink_is_busy('terminal_marker_update');
  v_busy_delete:=public.dblink_is_busy('terminal_marker_delete');
  IF v_busy_update<>1 OR v_busy_delete<>1 OR v_blocked_waiters<>2 THEN
    RAISE EXCEPTION
      'FAIL queued child writers were not both lock-waiting on holder tuples: update %, delete %, lock waiters %',
      v_busy_update,v_busy_delete,v_blocked_waiters;
  END IF;

  SELECT rows_stamped INTO v_holder_rows
    FROM public.dblink_get_result('terminal_marker_holder')
      AS result(rows_stamped integer);
  IF v_holder_rows<>2 THEN
    RAISE EXCEPTION 'FAIL holder stamped % child rows instead of 2',v_holder_rows;
  END IF;

  BEGIN
    PERFORM id FROM public.dblink_get_result('terminal_marker_update')
      AS result(id uuid);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE;
    IF v_state='55000' THEN v_update_refused:=true; ELSE RAISE; END IF;
  END;
  BEGIN
    PERFORM id FROM public.dblink_get_result('terminal_marker_delete')
      AS result(id uuid);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE;
    IF v_state='55000' THEN v_delete_refused:=true; ELSE RAISE; END IF;
  END;
  IF NOT v_update_refused OR NOT v_delete_refused THEN
    RAISE EXCEPTION
      'FAIL a pre-commit child writer crossed the terminal marker: update %, delete %',
      v_update_refused,v_delete_refused;
  END IF;

  PERFORM public.dblink_disconnect('terminal_marker_update');
  PERFORM public.dblink_disconnect('terminal_marker_delete');
  PERFORM public.dblink_disconnect('terminal_marker_holder');
  PERFORM public.dblink_connect('terminal_marker_verify',v_conn);
  SELECT total,marked,pristine INTO v_total,v_marked,v_pristine
    FROM public.dblink('terminal_marker_verify',$verify$
      SELECT count(*)::integer AS total,
             count(*) FILTER (
               WHERE terminal_closed_at=
                 '2026-09-08T15:33:29+00:00'::timestamptz)::integer AS marked,
             count(*) FILTER (
               WHERE metadata IN (
                 '{"probe":"queued_update"}'::jsonb,
                 '{"probe":"queued_delete"}'::jsonb))::integer AS pristine
        FROM public.rake_records
       WHERE id IN (
         '8d000000-0000-0000-0000-000000000011'::uuid,
         '8d000000-0000-0000-0000-000000000012'::uuid)
    $verify$) AS result(total integer,marked integer,pristine integer);
  IF v_total<>2 OR v_marked<>2 OR v_pristine<>2 THEN
    RAISE EXCEPTION
      'FAIL queued child race changed durable evidence: total %, marked %, pristine %',
      v_total,v_marked,v_pristine;
  END IF;

  PERFORM public.dblink_exec('terminal_marker_verify','BEGIN');
  PERFORM public.dblink_exec(
    'terminal_marker_verify','SET LOCAL session_replication_role = replica');
  PERFORM public.dblink_exec('terminal_marker_verify',$cleanup$
    DELETE FROM public.rake_records
     WHERE id IN (
       '8d000000-0000-0000-0000-000000000011'::uuid,
       '8d000000-0000-0000-0000-000000000012'::uuid)
  $cleanup$);
  PERFORM public.dblink_exec('terminal_marker_verify',$cleanup$
    DELETE FROM public.tournaments
     WHERE id='8d000000-0000-0000-0000-000000000001'::uuid
  $cleanup$);
  PERFORM public.dblink_exec('terminal_marker_verify','COMMIT');
  PERFORM public.dblink_disconnect('terminal_marker_verify');

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: queued child UPDATE and DELETE both waited behind committed tuple markers, then failed at SQLSTATE 55000 from the newest OLD rows; both exact markers and both pristine evidence rows survived; fixture removed';
EXCEPTION WHEN OTHERS THEN
  -- Best-effort connection and fixture cleanup also runs for the intentional
  -- PASS exception. Never hide the original assertion or remote SQLSTATE.
  BEGIN PERFORM public.dblink_cancel_query('terminal_marker_holder');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_cancel_query('terminal_marker_update');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_cancel_query('terminal_marker_delete');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('terminal_marker_holder');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('terminal_marker_update');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('terminal_marker_delete');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('terminal_marker_setup');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM public.dblink_disconnect('terminal_marker_verify');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN
    PERFORM public.dblink_connect('terminal_marker_cleanup',v_conn);
    PERFORM public.dblink_exec('terminal_marker_cleanup','BEGIN');
    PERFORM public.dblink_exec(
      'terminal_marker_cleanup','SET LOCAL session_replication_role = replica');
    PERFORM public.dblink_exec('terminal_marker_cleanup',$cleanup$
      DELETE FROM public.rake_records
       WHERE id IN (
         '8d000000-0000-0000-0000-000000000011'::uuid,
         '8d000000-0000-0000-0000-000000000012'::uuid)
    $cleanup$);
    PERFORM public.dblink_exec('terminal_marker_cleanup',$cleanup$
      DELETE FROM public.tournaments
       WHERE id='8d000000-0000-0000-0000-000000000001'::uuid
    $cleanup$);
    PERFORM public.dblink_exec('terminal_marker_cleanup','COMMIT');
    PERFORM public.dblink_disconnect('terminal_marker_cleanup');
  EXCEPTION WHEN OTHERS THEN
    BEGIN PERFORM public.dblink_disconnect('terminal_marker_cleanup');
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END;
  RAISE;
END;
$terminal_marker_race$;
