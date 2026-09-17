-- Source-only finite job259 completion observer. No new schedule, scan, or financial retry.
-- Existing business checker/cron command are unchanged by this component.
DO $component$
DECLARE
 v_remove constant boolean := false;
 v_body constant text := $handler$DECLARE
  v_command constant text := 'SET statement_timeout = ''600s''; SELECT CASE WHEN pg_try_advisory_lock(hashtext(''ca-cash-pot-conservation'')) THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check()) ELSE -1 END;';
  v_cutoff constant timestamptz := '2026-09-06T14:34:00.384087Z';
  v_source constant text := 'cash-pot-conservation-cron-failure';
  v_updates constant text := 'cash-pot-conservation-cron-failure-updates';
  v_alert constant text := 'CashPotConservationCheckFailed';
  v_original jsonb;
  v_snapshot jsonb;
  v_digest text;
  v_common jsonb;
  v_payload jsonb;
  v_parent public.operational_alert_events%ROWTYPE;
  v_receipt public.operational_alert_events%ROWTYPE;
  v_prior public.ca_cash_failed_run_outcomes%ROWTYPE;
  v_destination text;
  v_key text;
  v_id bigint;
  v_state text := 'intake_failed';
  v_error_code text;
  v_error_message text;
BEGIN
  -- This observer never calls the checker, changes the source row, or retries.
  IF TG_RELID <> 'cron.job_run_details'::regclass OR TG_WHEN <> 'AFTER'
     OR TG_LEVEL <> 'ROW' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'cash failure intake: invalid trigger attachment';
  END IF;
  IF NEW.jobid <> 259 OR NEW.status IS DISTINCT FROM 'failed' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
  IF NEW.start_time < v_cutoff OR (NEW.start_time IS NULL AND NEW.end_time < v_cutoff) THEN
    RETURN NEW;
  END IF;
  v_original := to_jsonb(NEW);
  v_digest := md5(v_original::text);
  v_snapshot := v_original || jsonb_build_object('return_message',left(NEW.return_message,4096),
    'command',left(NEW.command,4096));

  -- The outer subtransaction owns queue writes AND the separate outcome.
  -- A failed outcome write rolls back its attempted queue delivery, but cannot
  -- roll back pg_cron's original failed row. That missing outcome is NOT success.
  BEGIN
    SELECT * INTO v_prior FROM public.ca_cash_failed_run_outcomes
      WHERE jobid=259 AND runid=NEW.runid AND snapshot_md5=v_digest;
    IF FOUND THEN
      IF v_prior.run_snapshot IS DISTINCT FROM v_snapshot THEN
        RAISE EXCEPTION 'cash failure intake: outcome identity collision';
      END IF;
      IF v_prior.outcome='delivered' AND NOT EXISTS (
        SELECT 1 FROM public.operational_alert_events e
        WHERE e.id=v_prior.receipt_id AND e.source=v_prior.receipt_source
          AND e.event_key=v_prior.receipt_key AND e.alertname=v_alert
          AND e.status='firing' AND e.severity='critical'
          AND e.payload=v_prior.receipt_payload
      ) THEN RAISE EXCEPTION 'cash failure intake: delivered receipt drift'; END IF;
      -- A previously failed observation remains failed; another row event does
      -- not silently turn into a retry or overwrite its durable outcome.
      RETURN NEW;
    END IF;

    BEGIN
      IF NEW.runid IS NULL OR NEW.runid<=0 OR NEW.command IS DISTINCT FROM v_command
        OR NEW.database IS DISTINCT FROM 'postgres' OR NEW.username IS DISTINCT FROM 'postgres'
        OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid=259
          AND jobname='ca-cash-pot-conservation-hourly' AND command=v_command
          AND database='postgres' AND username='postgres' AND active
          AND nodename='localhost' AND nodeport=5432 AND schedule='34 */6 * * *') THEN
        RAISE EXCEPTION 'cash failure intake: job contract drift';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)')
          AND md5(pg_get_functiondef(p.oid))='36601e205494e8768f5a1dce09f4a186'
          AND pg_get_userbyid(p.proowner)='postgres' AND NOT p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
          AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN
        RAISE EXCEPTION 'cash failure intake: queue writer authority drift';
      END IF;
      v_common := jsonb_build_object('schema_version',1,
        'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','triggering_inbox_id',40538,
        'scope_basis','Failure of the exact received cash-pot detector; not a money correction',
        'producer','fn_cash_pot_conservation_check(integer)','scope_lower_bound',v_cutoff,
        'internal_check_id',NULL,'sqlstate',NULL,
        'evidence_limit','Cron text is retained scheduler failure evidence; no internal invocation, affected-hand set, payment or original SQLSTATE is inferred');
      SELECT * INTO v_parent FROM public.operational_alert_events
        WHERE source=v_source AND event_key='259:'||NEW.runid::text FOR UPDATE;
      IF FOUND AND v_parent.payload->>'original_run_md5' IS DISTINCT FROM v_digest THEN
        IF NOT EXISTS (SELECT 1 FROM public.ca_cash_failed_run_outcomes o
          WHERE o.jobid=259 AND o.runid=NEW.runid AND o.outcome='delivered'
            AND o.snapshot_md5=v_parent.payload->>'original_run_md5'
            AND o.receipt_id=v_parent.id AND o.receipt_source=v_source
            AND o.receipt_key=v_parent.event_key AND o.receipt_payload=v_parent.payload
            AND v_parent.alertname=v_alert AND v_parent.status='firing'
            AND v_parent.severity='critical') THEN
          RAISE EXCEPTION 'cash failure intake: unattested original receipt';
        END IF;
      END IF;
      v_destination := CASE WHEN v_parent.id IS NULL OR
        v_parent.payload->>'original_run_md5'=v_digest THEN v_source ELSE v_updates END;
      v_key := '259:'||NEW.runid::text||CASE WHEN v_destination=v_source THEN '' ELSE ':'||v_digest END;
      v_payload := v_common||jsonb_build_object(
        'original_run',v_original||jsonb_build_object('return_message',left(NEW.return_message,4096)),
        'original_run_md5',v_digest,
        'original_inbox_id',CASE WHEN v_destination=v_source THEN NULL::bigint ELSE v_parent.id END,
        'error_text_characters',length(NEW.return_message),'error_text_bytes',octet_length(NEW.return_message),
        'error_text_md5',md5(NEW.return_message),
        'error_text_truncated',coalesce(length(NEW.return_message)>4096,false),
        'time_scope',CASE WHEN NEW.start_time IS NOT NULL THEN 'at_or_after_received_case'
          WHEN NEW.end_time IS NOT NULL THEN 'start_unknown_end_at_or_after_received_case'
          ELSE 'start_and_end_unknown' END);
      IF octet_length(v_payload::text)>32768 THEN
        RAISE EXCEPTION 'cash failure intake: payload overflow';
      END IF;
      SELECT * INTO v_receipt FROM public.operational_alert_events
        WHERE source=v_destination AND event_key=v_key FOR UPDATE;
      IF FOUND THEN
        IF v_receipt.alertname IS DISTINCT FROM v_alert OR v_receipt.status IS DISTINCT FROM 'firing'
          OR v_receipt.severity IS DISTINCT FROM 'critical' OR v_receipt.payload IS DISTINCT FROM v_payload THEN
          RAISE EXCEPTION 'cash failure intake: immutable receipt collision';
        END IF;
        v_id:=v_receipt.id;
      ELSE
        v_id:=public.fn_record_operational_alert(v_destination,v_key,v_alert,'firing','critical',v_payload);
      END IF;
      IF v_id IS NULL OR v_id<=0 OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_events e WHERE e.id=v_id
          AND e.source=v_destination AND e.event_key=v_key AND e.alertname=v_alert
          AND e.status='firing' AND e.severity='critical' AND e.payload=v_payload) THEN
        RAISE EXCEPTION 'cash failure intake: receipt readback mismatch';
      END IF;
      v_state:='delivered';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error_code=RETURNED_SQLSTATE,v_error_message=MESSAGE_TEXT;
      v_state:='intake_failed'; v_id:=NULL; v_destination:=NULL; v_key:=NULL; v_payload:=NULL;
    END;
    INSERT INTO public.ca_cash_failed_run_outcomes
      (jobid,runid,snapshot_md5,run_snapshot,outcome,receipt_id,receipt_source,receipt_key,
       receipt_payload,intake_sqlstate,intake_message)
    VALUES(259,NEW.runid,v_digest,v_snapshot,v_state,v_id,v_destination,v_key,v_payload,
      v_error_code,left(v_error_message,512));
    IF v_state='intake_failed' THEN
      RAISE WARNING 'cash failure intake not delivered: job259 run% snapshot% intake_sqlstate%',
        NEW.runid,v_digest,v_error_code;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Preserve native failure status even if the outcome store is unavailable.
    -- This is an observable missing-outcome failure, never an acknowledged event.
    RAISE WARNING 'cash failure intake outcome unavailable: job259 run% snapshot% intake_sqlstate%',
      NEW.runid,v_digest,SQLSTATE;
  END;
  RETURN NEW;
END
$handler$;
 v_freeze constant text := $immutable$BEGIN
  RAISE EXCEPTION 'cash failed-run outcome is immutable';
END
$immutable$;
 v_shape constant text := $shape$(
  jobid bigint NOT NULL CHECK(jobid=259),
  runid bigint NOT NULL CHECK(runid>0),
  snapshot_md5 text NOT NULL CHECK(snapshot_md5 ~ '^[0-9a-f]{32}$'),
  run_snapshot jsonb NOT NULL CHECK(jsonb_typeof(run_snapshot)='object' AND octet_length(run_snapshot::text)<=32768),
  outcome text NOT NULL CHECK(outcome IN ('delivered','intake_failed')),
  receipt_id bigint,
  receipt_source text,
  receipt_key text,
  receipt_payload jsonb CHECK(receipt_payload IS NULL OR octet_length(receipt_payload::text)<=32768),
  intake_sqlstate text,
  intake_message text CHECK(intake_message IS NULL OR length(intake_message)<=512),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(jobid,runid,snapshot_md5),
  CHECK((outcome='delivered' AND receipt_id>0 AND receipt_source IS NOT NULL AND receipt_key IS NOT NULL
    AND receipt_payload IS NOT NULL AND intake_sqlstate IS NULL AND intake_message IS NULL)
    OR (outcome='intake_failed' AND receipt_id IS NULL AND receipt_source IS NULL AND receipt_key IS NULL
    AND receipt_payload IS NULL AND intake_sqlstate ~ '^[0-9A-Z]{5}$' AND intake_message IS NOT NULL))
)$shape$;
 v_handler_ddl constant text := $ddl$CREATE OR REPLACE FUNCTION public.fn_ca_cash_failed_run_intake() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog','public' SET TimeZone='UTC' SET lock_timeout='1s' AS $body$DECLARE
  v_command constant text := 'SET statement_timeout = ''600s''; SELECT CASE WHEN pg_try_advisory_lock(hashtext(''ca-cash-pot-conservation'')) THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check()) ELSE -1 END;';
  v_cutoff constant timestamptz := '2026-09-06T14:34:00.384087Z';
  v_source constant text := 'cash-pot-conservation-cron-failure';
  v_updates constant text := 'cash-pot-conservation-cron-failure-updates';
  v_alert constant text := 'CashPotConservationCheckFailed';
  v_original jsonb;
  v_snapshot jsonb;
  v_digest text;
  v_common jsonb;
  v_payload jsonb;
  v_parent public.operational_alert_events%ROWTYPE;
  v_receipt public.operational_alert_events%ROWTYPE;
  v_prior public.ca_cash_failed_run_outcomes%ROWTYPE;
  v_destination text;
  v_key text;
  v_id bigint;
  v_state text := 'intake_failed';
  v_error_code text;
  v_error_message text;
BEGIN
  -- This observer never calls the checker, changes the source row, or retries.
  IF TG_RELID <> 'cron.job_run_details'::regclass OR TG_WHEN <> 'AFTER'
     OR TG_LEVEL <> 'ROW' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'cash failure intake: invalid trigger attachment';
  END IF;
  IF NEW.jobid <> 259 OR NEW.status IS DISTINCT FROM 'failed' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
  IF NEW.start_time < v_cutoff OR (NEW.start_time IS NULL AND NEW.end_time < v_cutoff) THEN
    RETURN NEW;
  END IF;
  v_original := to_jsonb(NEW);
  v_digest := md5(v_original::text);
  v_snapshot := v_original || jsonb_build_object('return_message',left(NEW.return_message,4096),
    'command',left(NEW.command,4096));

  -- The outer subtransaction owns queue writes AND the separate outcome.
  -- A failed outcome write rolls back its attempted queue delivery, but cannot
  -- roll back pg_cron's original failed row. That missing outcome is NOT success.
  BEGIN
    SELECT * INTO v_prior FROM public.ca_cash_failed_run_outcomes
      WHERE jobid=259 AND runid=NEW.runid AND snapshot_md5=v_digest;
    IF FOUND THEN
      IF v_prior.run_snapshot IS DISTINCT FROM v_snapshot THEN
        RAISE EXCEPTION 'cash failure intake: outcome identity collision';
      END IF;
      IF v_prior.outcome='delivered' AND NOT EXISTS (
        SELECT 1 FROM public.operational_alert_events e
        WHERE e.id=v_prior.receipt_id AND e.source=v_prior.receipt_source
          AND e.event_key=v_prior.receipt_key AND e.alertname=v_alert
          AND e.status='firing' AND e.severity='critical'
          AND e.payload=v_prior.receipt_payload
      ) THEN RAISE EXCEPTION 'cash failure intake: delivered receipt drift'; END IF;
      -- A previously failed observation remains failed; another row event does
      -- not silently turn into a retry or overwrite its durable outcome.
      RETURN NEW;
    END IF;

    BEGIN
      IF NEW.runid IS NULL OR NEW.runid<=0 OR NEW.command IS DISTINCT FROM v_command
        OR NEW.database IS DISTINCT FROM 'postgres' OR NEW.username IS DISTINCT FROM 'postgres'
        OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid=259
          AND jobname='ca-cash-pot-conservation-hourly' AND command=v_command
          AND database='postgres' AND username='postgres' AND active
          AND nodename='localhost' AND nodeport=5432 AND schedule='34 */6 * * *') THEN
        RAISE EXCEPTION 'cash failure intake: job contract drift';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_proc p
        WHERE p.oid=to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)')
          AND md5(pg_get_functiondef(p.oid))='36601e205494e8768f5a1dce09f4a186'
          AND pg_get_userbyid(p.proowner)='postgres' AND NOT p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[]
          AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN
        RAISE EXCEPTION 'cash failure intake: queue writer authority drift';
      END IF;
      v_common := jsonb_build_object('schema_version',1,
        'target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','triggering_inbox_id',40538,
        'scope_basis','Failure of the exact received cash-pot detector; not a money correction',
        'producer','fn_cash_pot_conservation_check(integer)','scope_lower_bound',v_cutoff,
        'internal_check_id',NULL,'sqlstate',NULL,
        'evidence_limit','Cron text is retained scheduler failure evidence; no internal invocation, affected-hand set, payment or original SQLSTATE is inferred');
      SELECT * INTO v_parent FROM public.operational_alert_events
        WHERE source=v_source AND event_key='259:'||NEW.runid::text FOR UPDATE;
      IF FOUND AND v_parent.payload->>'original_run_md5' IS DISTINCT FROM v_digest THEN
        IF NOT EXISTS (SELECT 1 FROM public.ca_cash_failed_run_outcomes o
          WHERE o.jobid=259 AND o.runid=NEW.runid AND o.outcome='delivered'
            AND o.snapshot_md5=v_parent.payload->>'original_run_md5'
            AND o.receipt_id=v_parent.id AND o.receipt_source=v_source
            AND o.receipt_key=v_parent.event_key AND o.receipt_payload=v_parent.payload
            AND v_parent.alertname=v_alert AND v_parent.status='firing'
            AND v_parent.severity='critical') THEN
          RAISE EXCEPTION 'cash failure intake: unattested original receipt';
        END IF;
      END IF;
      v_destination := CASE WHEN v_parent.id IS NULL OR
        v_parent.payload->>'original_run_md5'=v_digest THEN v_source ELSE v_updates END;
      v_key := '259:'||NEW.runid::text||CASE WHEN v_destination=v_source THEN '' ELSE ':'||v_digest END;
      v_payload := v_common||jsonb_build_object(
        'original_run',v_original||jsonb_build_object('return_message',left(NEW.return_message,4096)),
        'original_run_md5',v_digest,
        'original_inbox_id',CASE WHEN v_destination=v_source THEN NULL::bigint ELSE v_parent.id END,
        'error_text_characters',length(NEW.return_message),'error_text_bytes',octet_length(NEW.return_message),
        'error_text_md5',md5(NEW.return_message),
        'error_text_truncated',coalesce(length(NEW.return_message)>4096,false),
        'time_scope',CASE WHEN NEW.start_time IS NOT NULL THEN 'at_or_after_received_case'
          WHEN NEW.end_time IS NOT NULL THEN 'start_unknown_end_at_or_after_received_case'
          ELSE 'start_and_end_unknown' END);
      IF octet_length(v_payload::text)>32768 THEN
        RAISE EXCEPTION 'cash failure intake: payload overflow';
      END IF;
      SELECT * INTO v_receipt FROM public.operational_alert_events
        WHERE source=v_destination AND event_key=v_key FOR UPDATE;
      IF FOUND THEN
        IF v_receipt.alertname IS DISTINCT FROM v_alert OR v_receipt.status IS DISTINCT FROM 'firing'
          OR v_receipt.severity IS DISTINCT FROM 'critical' OR v_receipt.payload IS DISTINCT FROM v_payload THEN
          RAISE EXCEPTION 'cash failure intake: immutable receipt collision';
        END IF;
        v_id:=v_receipt.id;
      ELSE
        v_id:=public.fn_record_operational_alert(v_destination,v_key,v_alert,'firing','critical',v_payload);
      END IF;
      IF v_id IS NULL OR v_id<=0 OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_events e WHERE e.id=v_id
          AND e.source=v_destination AND e.event_key=v_key AND e.alertname=v_alert
          AND e.status='firing' AND e.severity='critical' AND e.payload=v_payload) THEN
        RAISE EXCEPTION 'cash failure intake: receipt readback mismatch';
      END IF;
      v_state:='delivered';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error_code=RETURNED_SQLSTATE,v_error_message=MESSAGE_TEXT;
      v_state:='intake_failed'; v_id:=NULL; v_destination:=NULL; v_key:=NULL; v_payload:=NULL;
    END;
    INSERT INTO public.ca_cash_failed_run_outcomes
      (jobid,runid,snapshot_md5,run_snapshot,outcome,receipt_id,receipt_source,receipt_key,
       receipt_payload,intake_sqlstate,intake_message)
    VALUES(259,NEW.runid,v_digest,v_snapshot,v_state,v_id,v_destination,v_key,v_payload,
      v_error_code,left(v_error_message,512));
    IF v_state='intake_failed' THEN
      RAISE WARNING 'cash failure intake not delivered: job259 run% snapshot% intake_sqlstate%',
        NEW.runid,v_digest,v_error_code;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Preserve native failure status even if the outcome store is unavailable.
    -- This is an observable missing-outcome failure, never an acknowledged event.
    RAISE WARNING 'cash failure intake outcome unavailable: job259 run% snapshot% intake_sqlstate%',
      NEW.runid,v_digest,SQLSTATE;
  END;
  RETURN NEW;
END
$body$;$ddl$;
 v_freeze_ddl constant text := $ddl$CREATE OR REPLACE FUNCTION public.fn_ca_cash_failed_run_outcome_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog','public' AS $body$BEGIN
  RAISE EXCEPTION 'cash failed-run outcome is immutable';
END
$body$;$ddl$;
 v_new boolean; v_fn oid; v_trigger oid; v_rel oid; v_model oid; v_temp text; v_a jsonb; v_b jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('component:cash-failed-run-intake',0));
 IF current_user<>'postgres' OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
  OR NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron' AND extversion='1.6.4')
  OR NOT has_table_privilege(current_user,'cron.job_run_details','TRIGGER')
  OR current_setting('cron.use_background_workers')<>'off' OR current_setting('cron.log_run')<>'on' THEN
   RAISE EXCEPTION 'cash intake: exact existing PG17/pg_cron1.6.4 libpq authority required';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM cron.job WHERE jobid=259 AND jobname='ca-cash-pot-conservation-hourly'
  AND md5(command)='72b3dc33b68f7354a0282c676315bc84' AND database='postgres' AND username='postgres'
  AND active AND schedule='34 */6 * * *' AND nodename='localhost' AND nodeport=5432) THEN
   RAISE EXCEPTION 'cash intake: exact existing job259 required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_record_operational_alert(text,text,text,text,text,jsonb)')
  AND md5(pg_get_functiondef(oid))='36601e205494e8768f5a1dce09f4a186'
  AND pg_get_userbyid(proowner)='postgres' AND NOT prosecdef
  AND proconfig=ARRAY['search_path=pg_catalog, public']::text[]
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
   RAISE EXCEPTION 'cash intake: recorder authority differs'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
  WHERE d.classid='pg_class'::regclass AND d.objid='cron.job_run_details'::regclass
    AND d.refclassid='pg_extension'::regclass AND d.deptype='e' AND e.extname='pg_cron') THEN
   RAISE EXCEPTION 'cash intake: real extension run table required'; END IF;
 SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod)) ORDER BY a.attnum)
 INTO v_a FROM pg_attribute a WHERE a.attrelid='cron.job_run_details'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF v_a IS DISTINCT FROM '[ ["jobid","bigint"],["runid","bigint"],["job_pid","integer"],["database","text"],["username","text"],["command","text"],["status","text"],["return_message","text"],["start_time","timestamp with time zone"],["end_time","timestamp with time zone"] ]'::jsonb THEN
   RAISE EXCEPTION 'cash intake: native run row shape differs'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='cron.job_run_details'::regclass AND NOT tgisinternal
   AND tgname<>'ca_cash_failed_run_intake') THEN RAISE EXCEPTION 'cash intake: unexpected run observer'; END IF;
 v_rel:=to_regclass('public.ca_cash_failed_run_outcomes'); v_new:=v_rel IS NULL;
 IF v_new THEN
  IF v_remove THEN RAISE EXCEPTION 'cash intake: no installed outcome store'; END IF;
  IF to_regprocedure('public.fn_ca_cash_failed_run_intake()') IS NOT NULL
     OR to_regprocedure('public.fn_ca_cash_failed_run_outcome_immutable()') IS NOT NULL
     OR EXISTS(SELECT 1 FROM public.operational_alert_events WHERE source IN
       ('cash-pot-conservation-cron-failure','cash-pot-conservation-cron-failure-updates')) THEN
   RAISE EXCEPTION 'cash intake: unknown partial installation or unattested historical receipts'; END IF;
  EXECUTE 'CREATE TABLE public.ca_cash_failed_run_outcomes '||v_shape;
  ALTER TABLE public.ca_cash_failed_run_outcomes OWNER TO postgres;
  ALTER TABLE public.ca_cash_failed_run_outcomes ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.ca_cash_failed_run_outcomes FROM PUBLIC,anon,authenticated,service_role;
  GRANT SELECT ON public.ca_cash_failed_run_outcomes TO service_role;
  CREATE POLICY cash_failed_outcome_read ON public.ca_cash_failed_run_outcomes FOR SELECT TO service_role USING(true);
  EXECUTE v_freeze_ddl;
  ALTER FUNCTION public.fn_ca_cash_failed_run_outcome_immutable() OWNER TO postgres;
  REVOKE ALL ON FUNCTION public.fn_ca_cash_failed_run_outcome_immutable() FROM PUBLIC,anon,authenticated,service_role;
  CREATE TRIGGER cash_failed_outcome_immutable BEFORE UPDATE OR DELETE ON public.ca_cash_failed_run_outcomes
   FOR EACH ROW EXECUTE FUNCTION public.fn_ca_cash_failed_run_outcome_immutable();
  CREATE TRIGGER cash_failed_outcome_no_truncate BEFORE TRUNCATE ON public.ca_cash_failed_run_outcomes
   FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_cash_failed_run_outcome_immutable();
  v_rel:='public.ca_cash_failed_run_outcomes'::regclass;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=v_rel AND relkind='r' AND relpersistence='p'
   AND pg_get_userbyid(relowner)='postgres' AND relrowsecurity AND NOT relforcerowsecurity
   AND relacl::text='{postgres=arwdDxtm/postgres,service_role=r/postgres}') THEN
  RAISE EXCEPTION 'cash intake: outcome store authority drift'; END IF;
 v_temp:='cash_outcome_model_'||replace(gen_random_uuid()::text,'-','');
 EXECUTE format('CREATE TEMP TABLE %I %s ON COMMIT DROP',v_temp,v_shape);
 v_model:=to_regclass('pg_temp.'||v_temp);
 SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
   a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO v_a
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=v_rel AND a.attnum>0 AND NOT a.attisdropped;
 SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
   a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO v_b
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=v_model AND a.attnum>0 AND NOT a.attisdropped;
 IF v_a IS DISTINCT FROM v_b THEN RAISE EXCEPTION 'cash intake: outcome columns drift'; END IF;
 SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO v_a FROM pg_constraint WHERE conrelid=v_rel;
 SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO v_b FROM pg_constraint WHERE conrelid=v_model;
 IF v_a IS DISTINCT FROM v_b THEN RAISE EXCEPTION 'cash intake: outcome constraints drift'; END IF;
 EXECUTE format('DROP TABLE pg_temp.%I',v_temp);
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ca_cash_failed_run_outcomes'
  AND policyname='cash_failed_outcome_read' AND permissive='PERMISSIVE' AND cmd='SELECT'
  AND roles=ARRAY['service_role']::name[] AND qual='true' AND with_check IS NULL)
  OR (SELECT count(*) FROM pg_policy WHERE polrelid=v_rel)<>1 THEN RAISE EXCEPTION 'cash intake: outcome RLS drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_cash_failed_run_outcome_immutable()')
  AND prosrc=v_freeze AND NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog, public']::text[]
  AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}')
  OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=v_rel AND NOT tgisinternal)<>2
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=v_rel AND tgname='cash_failed_outcome_immutable'
   AND tgfoid=to_regprocedure('public.fn_ca_cash_failed_run_outcome_immutable()') AND tgtype=27 AND tgenabled='O')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=v_rel AND tgname='cash_failed_outcome_no_truncate'
   AND tgfoid=to_regprocedure('public.fn_ca_cash_failed_run_outcome_immutable()') AND tgtype=34 AND tgenabled='O') THEN
  RAISE EXCEPTION 'cash intake: immutable outcome authority drift'; END IF;
 v_fn:=to_regprocedure('public.fn_ca_cash_failed_run_intake()');
 IF v_fn IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_fn AND prosrc=v_body
  AND prosecdef AND pg_get_userbyid(proowner)='postgres' AND prorettype='trigger'::regtype
  AND proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC','lock_timeout=1s']::text[]
  AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'cash intake: handler source/authority drift'; END IF;
 IF v_fn IS NULL AND NOT v_remove THEN
  EXECUTE v_handler_ddl;
  ALTER FUNCTION public.fn_ca_cash_failed_run_intake() OWNER TO postgres;
  REVOKE ALL ON FUNCTION public.fn_ca_cash_failed_run_intake() FROM PUBLIC,anon,authenticated,service_role;
  v_fn:=to_regprocedure('public.fn_ca_cash_failed_run_intake()');
 END IF;
 IF v_fn IS NULL THEN RAISE EXCEPTION 'cash intake: handler missing'; END IF;
 v_temp:='cash_filter_model_'||replace(gen_random_uuid()::text,'-','');
 EXECUTE format('CREATE TEMP TABLE %I (LIKE cron.job_run_details) ON COMMIT DROP',v_temp);
 EXECUTE format('CREATE TRIGGER expected_cash_filter AFTER INSERT OR UPDATE ON pg_temp.%I FOR EACH ROW WHEN(NEW.jobid=259 AND NEW.status=''failed'') EXECUTE FUNCTION public.fn_ca_cash_failed_run_intake()',v_temp);
 SELECT to_jsonb(regexp_replace(tgqual::text,':location -?[0-9]+',':location 0','g')) INTO v_a
 FROM pg_trigger WHERE tgrelid=to_regclass('pg_temp.'||v_temp) AND tgname='expected_cash_filter';
 EXECUTE format('DROP TABLE pg_temp.%I',v_temp);
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='cron.job_run_details'::regclass AND tgname='ca_cash_failed_run_intake'
  AND (tgfoid IS DISTINCT FROM v_fn OR tgtype<>21 OR tgenabled<>'O' OR tgnargs<>0
    OR to_jsonb(regexp_replace(tgqual::text,':location -?[0-9]+',':location 0','g')) IS DISTINCT FROM v_a)) THEN
  RAISE EXCEPTION 'cash intake: observer wiring drift'; END IF;
 IF v_remove THEN
  IF v_fn IS NULL OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='cron.job_run_details'::regclass
    AND tgname='ca_cash_failed_run_intake') THEN RAISE EXCEPTION 'cash intake: installation incomplete'; END IF;
  -- postgres owns this handler but does not own the extension's run table.
  -- DROP TRIGGER therefore lacks authority even though CREATE TRIGGER is granted.
  -- Dropping our owned function may remove ONLY its one exact normal dependency.
  SELECT oid INTO STRICT v_trigger FROM pg_trigger
   WHERE tgrelid='cron.job_run_details'::regclass AND tgname='ca_cash_failed_run_intake';
  IF (SELECT count(*) FROM pg_depend WHERE refclassid='pg_proc'::regclass
       AND refobjid=v_fn)<>1
    OR NOT EXISTS(SELECT 1 FROM pg_depend WHERE refclassid='pg_proc'::regclass
       AND refobjid=v_fn AND refobjsubid=0 AND classid='pg_trigger'::regclass
       AND objid=v_trigger AND objsubid=0 AND deptype='n')
    OR EXISTS(SELECT 1 FROM pg_depend WHERE refclassid='pg_trigger'::regclass AND refobjid=v_trigger)
    OR EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass AND objid=v_fn AND deptype='e') THEN
    RAISE EXCEPTION 'cash intake: rollback dependency boundary drift';
  END IF;
  DROP FUNCTION public.fn_ca_cash_failed_run_intake() CASCADE;
  IF to_regprocedure('public.fn_ca_cash_failed_run_intake()') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='cron.job_run_details'::regclass
      AND tgname='ca_cash_failed_run_intake') THEN
    RAISE EXCEPTION 'cash intake: owned handler removal incomplete';
  END IF;
 ELSE
  IF v_fn IS NULL THEN
   EXECUTE v_handler_ddl;
   ALTER FUNCTION public.fn_ca_cash_failed_run_intake() OWNER TO postgres;
   REVOKE ALL ON FUNCTION public.fn_ca_cash_failed_run_intake() FROM PUBLIC,anon,authenticated,service_role;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='cron.job_run_details'::regclass AND tgname='ca_cash_failed_run_intake') THEN
   CREATE TRIGGER ca_cash_failed_run_intake AFTER INSERT OR UPDATE ON cron.job_run_details
    FOR EACH ROW WHEN(NEW.jobid=259 AND NEW.status='failed') EXECUTE FUNCTION public.fn_ca_cash_failed_run_intake();
  END IF;
 END IF;
END
$component$;
