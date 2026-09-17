-- SOURCE ONLY. Exact reader bytes for exception qualification; no execution receipt.
CREATE TEMP TABLE qualification_cash_reader_source(source text NOT NULL);
INSERT INTO qualification_cash_reader_source VALUES ($exact_reader$-- SOURCE ONLY / UNRUN. Parent-owned companion to cash-pot-check-evidence.
-- The protected reader must execute this whole file in one transaction, with
-- statement_timeout=8s set BEFORE execution and an external absolute deadline.
-- Only durable operational intake changes; never invoke the cash checker.
-- No high-water cursor: a previously running lower runid may fail later.
DO $intake$
DECLARE
  v_cutoff constant timestamptz := '2026-09-06T14:34:00.384087Z';
  v_command constant text := 'SET statement_timeout = ''600s''; SELECT CASE WHEN pg_try_advisory_lock(hashtext(''ca-cash-pot-conservation'')) THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check()) ELSE -1 END;';
  v_source constant text := 'cash-pot-conservation-cron-failure';
  v_updates constant text := 'cash-pot-conservation-cron-failure-updates';
  v_alert constant text := 'CashPotConservationCheckFailed';
  v_target constant text := '01a09b86-5ba8-7290-8657-1041f13dd3ca';
  v_run record;
  v_original jsonb;
  v_digest text;
  v_common_payload jsonb;
  v_payload jsonb;
  v_key text;
  v_destination text;
  v_parent bigint;
  v_parent_digest text;
  v_id bigint;
  v_acknowledged integer := 0;
  v_receipts jsonb := '[]'::jsonb;
  v_result jsonb;
  v_more boolean;
BEGIN
  PERFORM set_config('search_path','pg_catalog, public',true);
  PERFORM set_config('TimeZone','UTC',true);
  PERFORM set_config('lock_timeout','1s',true);
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'cash failed intake: protected postgres reader required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid=to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)')
      AND md5(pg_get_functiondef(p.oid))='36601e205494e8768f5a1dce09f4a186'
      AND pg_get_userbyid(p.proowner)='postgres' AND NOT p.prosecdef
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
      AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
  ) THEN RAISE EXCEPTION 'cash failed intake: exact queue writer authority required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid=259
      AND jobname='ca-cash-pot-conservation-hourly' AND command=v_command
      AND database='postgres' AND username='postgres' AND active
      AND nodename='localhost' AND nodeport=5432
      AND schedule='34 */6 * * *') THEN
    RAISE EXCEPTION 'cash failed intake: checker job contract drift';
  END IF;

  v_common_payload:=jsonb_build_object(
    'schema_version',1,'target_task_id',v_target,'triggering_inbox_id',40538,
    'scope_basis','Failure of the exact received cash-pot detector; not a money correction',
    'producer','fn_cash_pot_conservation_check(integer)',
    'scope_lower_bound',v_cutoff,'internal_check_id',NULL,'sqlstate',NULL,
    'evidence_limit','Cron text is retained scheduler failure evidence; no internal invocation, affected-hand set, payment or original SQLSTATE is inferred');

  -- Never hide a corrupted existing acknowledgement behind the digest filter.
  -- Legitimate later source snapshots are linked updates, not overwritten originals.
  IF EXISTS (SELECT 1 FROM public.operational_alert_events e
    WHERE e.source IN(v_source,v_updates) AND (
      (e.id>0 AND e.alertname=v_alert AND e.status='firing' AND e.severity='critical'
       AND e.payload @> v_common_payload
       AND e.payload#>>'{original_run,jobid}'='259'
       AND e.payload#>>'{original_run,status}'='failed'
       AND e.payload#>>'{original_run,command}'=v_command
       AND e.payload#>>'{original_run,database}'='postgres'
       AND e.payload#>>'{original_run,username}'='postgres'
       AND e.payload#>>'{original_run,runid}' ~ '^[1-9][0-9]*$'
       AND e.payload->>'original_run_md5' ~ '^[0-9a-f]{32}$'
       AND e.event_key='259:'||(e.payload#>>'{original_run,runid}')
         ||CASE WHEN e.source=v_updates THEN ':'||(e.payload->>'original_run_md5') ELSE '' END
       AND jsonb_typeof(e.payload->'error_text_truncated')='boolean'
       AND e.payload->>'time_scope' IN (
         'at_or_after_received_case','start_unknown_end_at_or_after_received_case',
         'start_and_end_unknown')
       AND CASE WHEN e.source=v_source THEN
         e.payload->'original_inbox_id'='null'::jsonb
       ELSE EXISTS (
         SELECT 1 FROM public.operational_alert_events b
         WHERE b.source=v_source
           AND b.id::text=e.payload->>'original_inbox_id'
           AND b.event_key='259:'||(e.payload#>>'{original_run,runid}')
           AND b.payload#>>'{original_run,runid}'=e.payload#>>'{original_run,runid}'
           AND b.payload->>'original_run_md5'<>e.payload->>'original_run_md5'
       ) END) IS DISTINCT FROM true
      OR (e.payload->>'error_text_truncated'='false'
          AND e.payload->>'original_run_md5' IS DISTINCT FROM md5((e.payload->'original_run')::text))
    )) THEN
    RAISE EXCEPTION 'cash failed intake: corrupt existing acknowledgement';
  END IF;

  -- A digest alone cannot validate a stored truncated prefix. For every retained
  -- matching snapshot, compare the entire expected payload before skipping it.
  -- If the source was purged or changed, its old full long text is unavailable;
  -- the preceding structural/link checks are not proof of that missing text.
  IF EXISTS (
    SELECT 1 FROM public.operational_alert_events e
    JOIN cron.job_run_details r
      ON e.payload#>>'{original_run,runid}'=r.runid::text
      AND e.payload->>'original_run_md5'=md5(to_jsonb(r)::text)
    LEFT JOIN public.operational_alert_events b
      ON b.source=v_source AND b.event_key='259:'||r.runid::text
    WHERE e.source IN(v_source,v_updates) AND (
      (r.jobid=259 AND r.command=v_command AND r.database='postgres'
       AND r.username='postgres' AND r.status='failed'
       AND (r.start_time>=v_cutoff OR (r.start_time IS NULL
         AND (r.end_time IS NULL OR r.end_time>=v_cutoff)))) IS DISTINCT FROM true
      OR e.payload IS DISTINCT FROM v_common_payload||jsonb_build_object(
        'original_run',to_jsonb(r)||jsonb_build_object('return_message',left(r.return_message,4096)),
        'original_run_md5',md5(to_jsonb(r)::text),
        'original_inbox_id',CASE WHEN e.source=v_source THEN NULL::bigint ELSE b.id END,
        'error_text_characters',length(r.return_message),
        'error_text_bytes',octet_length(r.return_message),
        'error_text_md5',md5(r.return_message),
        'error_text_truncated',coalesce(length(r.return_message)>4096,false),
        'time_scope',CASE WHEN r.start_time IS NOT NULL THEN 'at_or_after_received_case'
          WHEN r.end_time IS NOT NULL THEN 'start_unknown_end_at_or_after_received_case'
          ELSE 'start_and_end_unknown' END))
  ) THEN
    RAISE EXCEPTION 'cash failed intake: retained snapshot payload mismatch';
  END IF;

  -- Revisit retained failures, including terminal transitions below a previously
  -- imported runid. Nothing moves a cursor past an unfiled original.
  -- A NULL start is retained unless a known end proves it predates the case.
  FOR v_run IN
    SELECT r.* FROM cron.job_run_details r
    WHERE r.jobid=259 AND r.command=v_command AND r.database='postgres'
      AND r.username='postgres' AND r.status='failed'
      AND (r.start_time>=v_cutoff OR (r.start_time IS NULL
        AND (r.end_time IS NULL OR r.end_time>=v_cutoff)))
      AND NOT EXISTS (
        SELECT 1 FROM public.operational_alert_events e
        WHERE e.source IN (v_source,v_updates)
          AND e.payload->>'original_run_md5'=md5(to_jsonb(r)::text)
          AND e.payload#>>'{original_run,runid}'=r.runid::text
          AND e.payload#>>'{original_run,jobid}'='259'
      )
    ORDER BY r.runid LIMIT 100
  LOOP
    v_original:=to_jsonb(v_run);
    v_digest:=md5(v_original::text);
    SELECT e.id,e.payload->>'original_run_md5' INTO v_parent,v_parent_digest
      FROM public.operational_alert_events e
      WHERE e.source=v_source AND e.event_key='259:'||v_run.runid::text;
    -- An identical original may commit after the cursor selected this row.
    -- Reuse its original key; mere parent existence is not a changed snapshot.
    v_destination:=CASE WHEN v_parent IS NULL OR v_parent_digest=v_digest
      THEN v_source ELSE v_updates END;
    v_key:='259:'||v_run.runid::text
      || CASE WHEN v_destination=v_source THEN '' ELSE ':'||v_digest END;
    v_payload:=v_common_payload||jsonb_build_object(
      'original_run',v_original||jsonb_build_object(
        'return_message',left(v_run.return_message,4096)),
      'original_run_md5',v_digest,
      'original_inbox_id',CASE WHEN v_destination=v_source THEN NULL::bigint ELSE v_parent END,
      'error_text_characters',length(v_run.return_message),
      'error_text_bytes',octet_length(v_run.return_message),
      'error_text_md5',md5(v_run.return_message),
      'error_text_truncated',coalesce(length(v_run.return_message)>4096,false),
      'time_scope',CASE WHEN v_run.start_time IS NOT NULL THEN 'at_or_after_received_case'
        WHEN v_run.end_time IS NOT NULL THEN 'start_unknown_end_at_or_after_received_case'
        ELSE 'start_and_end_unknown' END);
    IF octet_length(v_payload::text)>32768 THEN
      RAISE EXCEPTION 'cash failed intake: bounded payload overflow for run %',v_run.runid;
    END IF;
    v_id:=public.fn_record_operational_alert(
      v_destination,v_key,v_alert,'firing','critical',v_payload);
    IF v_id IS NULL OR v_id<=0 OR NOT EXISTS (
      SELECT 1 FROM public.operational_alert_events e
      WHERE e.id=v_id AND e.source=v_destination AND e.event_key=v_key
        AND e.alertname=v_alert AND e.status='firing' AND e.severity='critical'
        AND e.payload=v_payload
    ) THEN
      -- The shared writer accepts changed same-key payloads. Acknowledgement
      -- therefore requires strict readback; an ID alone is not delivery proof.
      RAISE EXCEPTION 'cash failed intake: immutable receipt mismatch for run %',v_run.runid;
    END IF;
    v_acknowledged:=v_acknowledged+1;
    v_receipts:=v_receipts||jsonb_build_array(jsonb_build_object(
      'id',v_id,'source',v_destination,'event_key',v_key,
      'alertname',v_alert,'status','firing','severity','critical',
      'expected_payload_md5',md5(v_payload::text)));
  END LOOP;
  SELECT EXISTS (
    SELECT 1 FROM cron.job_run_details r
    WHERE r.jobid=259 AND r.command=v_command AND r.database='postgres'
      AND r.username='postgres' AND r.status='failed'
      AND (r.start_time>=v_cutoff OR (r.start_time IS NULL
        AND (r.end_time IS NULL OR r.end_time>=v_cutoff)))
      AND NOT EXISTS (
        SELECT 1 FROM public.operational_alert_events e
        WHERE e.source IN (v_source,v_updates)
          AND e.payload->>'original_run_md5'=md5(to_jsonb(r)::text)
          AND e.payload#>>'{original_run,runid}'=r.runid::text
          AND e.payload#>>'{original_run,jobid}'='259'
      )
  ) INTO v_more;
  v_result:=jsonb_build_object(
    'observed_at',clock_timestamp(),'acknowledged_snapshots',v_acknowledged,'batch_limit',100,
    'acknowledged_receipts',v_receipts,
    'more_retained_failures',v_more,'historical_retention_complete',false,
    'scope_lower_bound',v_cutoff,'cursor_advanced',false);
  IF jsonb_array_length(v_receipts)>100 OR octet_length(v_result::text)>65536 THEN
    RAISE EXCEPTION 'cash failed intake: bounded result overflow';
  END IF;
  PERFORM set_config('operational.cash_failed_intake_result',v_result::text,true);
END;
$intake$;
SELECT current_setting('operational.cash_failed_intake_result')::jsonb AS result;
$exact_reader$);
