# SOURCE ONLY / UNRUN. PostgreSQL isolationtester specification.
# Executor must prepare and COMMIT a fresh admitted qual_cash_<execution UUID>
# database using the pinned preimage + original-40538 + actual component source.
# Every backend must receive the same approved execution UUID in its session GUC.
# This spec cannot create an approval, provider identity or terminal receipt.
setup
{
  DO $guard$
  BEGIN
    IF current_user<>'postgres'
       OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
       OR current_database()<>'qual_cash_'||replace(current_setting('cash_qualification.execution_uuid')::uuid::text,'-','')
       OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN ('127.0.0.1'::inet,'::1'::inet))
       OR NOT EXISTS(SELECT 1 FROM cash_qualification.admission
         WHERE execution_uuid=current_setting('cash_qualification.execution_uuid')::uuid)
       OR (SELECT count(*) FROM public.ca_cash_pot_check_evidence)<>0
       OR (SELECT count(*) FROM public.ca_cash_pot_check_anomalies)<>0
       OR (SELECT count(*) FROM public.operational_alert_events)<>0 THEN
      RAISE EXCEPTION 'cash concurrency requires separately admitted prepared empty allocation';
    END IF;
    IF md5(pg_get_functiondef('public.fn_cash_pot_conservation_check(integer)'::regprocedure))
         IS DISTINCT FROM 'a7080e4bdd9a513c2f11c67c51b5d1a6'
       OR md5(pg_get_functiondef('public.fn_ca_cash_pot_evidence_append_only()'::regprocedure))
         IS DISTINCT FROM '8b1f89fa4c293c62e1df59937783d567' THEN
      RAISE EXCEPTION 'cash concurrency requires separately admitted prepared empty allocation';
    END IF;
  END $guard$;
  SET statement_timeout='120s';
  SET lock_timeout='15s';
  TRUNCATE public.hand_history;
  INSERT INTO public.hand_history(id,table_id,hand_number,created_at,pot_size,rake_amount,bbj_amount,winners)
  SELECT ('c4053804-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,
    'c4053804-1111-4000-8000-000000000001',g,now(),1,0,0,'[]'
    FROM generate_series(1,100) g;
  -- Explicit fixture-only source observer: the checker body remains exact.
  -- A volatile projected pot reader blocks inside its source SELECT snapshot.
  -- This is not the production table plan or a performance qualification.
  ALTER TABLE public.hand_history SET SCHEMA cash_qualification;
  ALTER TABLE cash_qualification.hand_history RENAME TO source_hands;
  CREATE FUNCTION cash_qualification.source_snapshot_barrier(p_pot numeric) RETURNS numeric LANGUAGE plpgsql AS $f$
  BEGIN
    IF current_setting('cash_qualification.barrier',true)='on' THEN
      PERFORM pg_advisory_xact_lock(40538,1);
    END IF;
    RETURN p_pot;
  END $f$;
  CREATE VIEW public.hand_history AS
   SELECT id,table_id,hand_number,created_at,tournament_id,
     cash_qualification.source_snapshot_barrier(pot_size) AS pot_size,rake_amount,bbj_amount,winners
   FROM cash_qualification.source_hands;
}

teardown
{
  -- No DROP or TRUNCATE of append-only evidence here. The owner exports actual
  -- rows/WAL/receipt assertions, stops every backend, then destroys only this
  -- independently identified disposable allocation. That terminal proof is
  -- separate from isolationtester finishing. Never apply to a live database.
  SELECT current_database(),current_setting('cash_qualification.execution_uuid');
}


session "blocker"
setup { SET statement_timeout='120s'; SET lock_timeout='15s'; }
step "hold" { BEGIN; SELECT pg_advisory_xact_lock(40538,1); }
step "mutate_source"
{
  SELECT cash_qualification.assert_true(EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
    AND classid=40538 AND objid=1 AND NOT granted),'scanner actually waiting on owned source-snapshot barrier');
  UPDATE cash_qualification.source_hands SET winners=jsonb_build_array(jsonb_build_object('amount',1));
  INSERT INTO cash_qualification.source_hands VALUES(
    'c4053804-0000-4000-8000-000000000101',NULL,101,now(),NULL,1,0,0,'[]');
}
step "release" { COMMIT; }
step "restore_source"
{
 UPDATE cash_qualification.source_hands SET winners='[]';
 DELETE FROM cash_qualification.source_hands WHERE hand_number=101;
}

session "scanner"
setup { SET statement_timeout='120s'; SET lock_timeout='15s'; }
step "scan_begin" { BEGIN; SET LOCAL cash_qualification.barrier='on'; }
step "scan" { SELECT public.fn_cash_pot_conservation_check(24); }
step "scan_commit" { COMMIT; }
step "scan_begin_again" { BEGIN; SET LOCAL cash_qualification.barrier='off'; }
step "scan_again" { SELECT public.fn_cash_pot_conservation_check(24); }
step "scan_commit_again" { COMMIT; }
step "assert_snapshot"
{
  SELECT cash_qualification.assert_true(
    (SELECT count(*)=1 AND min(anomaly_rows)=100 FROM public.ca_cash_pot_check_evidence)
    AND (SELECT count(*)=100 AND bool_and(winner_count=0 AND recorded_awarded=0)
      FROM public.ca_cash_pot_check_anomalies)
    AND NOT EXISTS(SELECT 1 FROM public.ca_cash_pot_check_anomalies
      WHERE hand_id='c4053804-0000-4000-8000-000000000101')
    AND (SELECT count(*)=101 AND count(*) FILTER(WHERE jsonb_array_length(winners)=1)=100
      FROM public.hand_history),
    'one source statement excludes later updates/insert across cursor fetch batches');
}

session "observer"
setup { SET statement_timeout='120s'; SET lock_timeout='15s'; }
step "invisible_before_commit"
{
  SELECT cash_qualification.assert_true(
    (SELECT count(*)=0 FROM public.ca_cash_pot_check_evidence)
    AND (SELECT count(*)=0 FROM public.ca_cash_pot_check_anomalies)
    AND (SELECT count(*)=0 FROM public.operational_alert_events),
    'uncommitted complete evidence is not externally visible');
}
step "durable_after_commit"
{
  SELECT cash_qualification.assert_true(
    (SELECT count(*)=1 FROM public.ca_cash_pot_check_evidence)
    AND (SELECT count(*)=100 FROM public.ca_cash_pot_check_anomalies)
    AND (SELECT count(*)=1 AND bool_and(payload->>'financial_alert_id'=
      '33f6a110-4591-4ce7-a249-6311e0584f9b'
      AND payload->>'target_task_id'='01a09b86-5ba8-7290-8657-1041f13dd3ca')
      FROM public.operational_alert_events),
    'other backend observes committed full evidence and exact original link');
}

session "concurrent"
setup { SET statement_timeout='120s'; SET lock_timeout='15s'; }
step "second_begin" { BEGIN; }
step "second_scan" { SELECT public.fn_cash_pot_conservation_check(24); }
step "second_commit" { COMMIT; }
step "assert_distinct_invocations"
{
  SELECT cash_qualification.assert_true(
    (SELECT count(*)=3 AND count(DISTINCT check_id)=3
      AND sum(anomaly_rows)=300 FROM public.ca_cash_pot_check_evidence)
    AND (SELECT count(*)=300 FROM public.ca_cash_pot_check_anomalies)
    AND (SELECT count(*)=3 AND count(DISTINCT event_key)=3
      AND bool_and(payload->>'financial_alert_id'='33f6a110-4591-4ce7-a249-6311e0584f9b')
      FROM public.operational_alert_events)
    AND (SELECT count(*)=1 AND bool_and(context->>'chips'='600') FROM public.financial_alerts),
    'concurrent checks retain separate UUIDs while old financial UUID stays unchanged');
}

# A single permutation uses one fresh allocation: statement snapshot, invisible
# before commit, externally visible after commit, then two concurrent invocations.
# No evidence is deleted between those assertions. The source reset below touches
# only synthetic fixture hands, never the immutable evidence or old financial row.
permutation "hold" "scan_begin" "scan" "mutate_source" "release" "invisible_before_commit" "scan_commit" "assert_snapshot" "durable_after_commit" "restore_source" "scan_begin_again" "scan_again" "second_begin" "second_scan" "scan_commit_again" "second_commit" "assert_distinct_invocations"
