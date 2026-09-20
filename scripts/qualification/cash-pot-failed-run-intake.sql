-- SOURCE ONLY / UNRUN. Private PostgreSQL17 source qualification.
-- Never run against production. Native owner supplies authenticated admission,
-- no production credentials/network, external deadline and cleanup receipts.
\set ON_ERROR_STOP on
DO $admission$
DECLARE v_id text:=current_setting('qualification.execution_uuid',true);
BEGIN
 IF v_id IS NULL OR v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR current_database()<>'qual_cash_failure_'||replace(v_id,'-','')
 OR current_user<>'postgres' OR session_user<>'postgres'
 OR (inet_server_addr() IS NOT NULL AND inet_server_addr() NOT IN('127.0.0.1'::inet,'::1'::inet))
 OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
 OR to_regnamespace('cron') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace)
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace)
 OR (SELECT count(*) FROM pg_roles WHERE rolname IN('anon','authenticated','service_role'))<>3 THEN
  RAISE EXCEPTION 'Requires admitted empty local PostgreSQL17 cash-failure allocation';
 END IF;
END;
$admission$;
BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='1s';
SET LOCAL timezone='UTC';
CREATE FUNCTION pg_temp.assert_true(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'qualification assertion: %',label; END IF; END $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigint PRIMARY KEY,jobname text,command text,database text,username text,active boolean,schedule text,nodename text,nodeport integer);
CREATE TABLE cron.job_run_details(jobid bigint,runid bigint PRIMARY KEY,job_pid integer,database text,username text,command text,status text,return_message text,start_time timestamptz,end_time timestamptz);
CREATE TABLE public.operational_alert_events(id bigserial PRIMARY KEY,source text NOT NULL,event_key text NOT NULL,alertname text NOT NULL,status text NOT NULL,severity text NOT NULL,payload jsonb NOT NULL,last_received_at timestamptz DEFAULT clock_timestamp(),delivery_count integer DEFAULT 1,UNIQUE(source,event_key));
\ir fixtures/cash-pot-failed-run-intake/writer.sql
\ir fixtures/cash-pot-failed-run-intake/reader-source.sql
CREATE FUNCTION pg_temp.run_cash_intake() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
 EXECUTE (SELECT source FROM pg_temp.qualification_cash_reader_source);
 v_result:=current_setting('operational.cash_failed_intake_result')::jsonb;
 PERFORM pg_temp.assert_cash_receipts(v_result);
 RETURN v_result;
END $$;
CREATE FUNCTION pg_temp.assert_cash_receipts(v_result jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_temp.assert_true(jsonb_typeof(v_result->'acknowledged_receipts')='array',
   'acknowledged receipt vector exists');
 PERFORM pg_temp.assert_true(jsonb_array_length(v_result->'acknowledged_receipts')<=100
   AND jsonb_array_length(v_result->'acknowledged_receipts')::text=v_result->>'acknowledged_snapshots'
   AND octet_length(v_result::text)<=65536,'result count and serialized bound');
 PERFORM pg_temp.assert_true(NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(v_result->'acknowledged_receipts') q(receipt)
   LEFT JOIN public.operational_alert_events e ON e.id::text=q.receipt->>'id'
   WHERE (e.id>0 AND e.source=q.receipt->>'source'
     AND e.event_key=q.receipt->>'event_key'
     AND e.alertname=q.receipt->>'alertname' AND e.status=q.receipt->>'status'
     AND e.severity=q.receipt->>'severity'
     AND md5(e.payload::text)=q.receipt->>'expected_payload_md5') IS DISTINCT FROM true
 ),'each returned ID/key/classification/payload digest identifies this exact receipt');
 PERFORM pg_temp.assert_true((SELECT count(*)=count(DISTINCT receipt->>'id')
   FROM jsonb_array_elements(v_result->'acknowledged_receipts') q(receipt)),
   'receipt vector has no duplicate IDs');
END $$;
CREATE FUNCTION pg_temp.assert_refused(expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_error text;
BEGIN
 BEGIN
  PERFORM pg_temp.run_cash_intake();
 EXCEPTION WHEN raise_exception THEN v_error:=SQLERRM;
 END;
 PERFORM pg_temp.assert_true(v_error IS NOT NULL AND position(expected IN v_error)>0,'exact intended refusal: '||expected);
END $$;
INSERT INTO cron.job VALUES(259,'ca-cash-pot-conservation-hourly',
 'SET statement_timeout = ''600s''; SELECT CASE WHEN pg_try_advisory_lock(hashtext(''ca-cash-pot-conservation'')) THEN (SELECT count(*)::int FROM public.fn_cash_pot_conservation_check()) ELSE -1 END;',
 'postgres','postgres',true,'34 */6 * * *','localhost',5432);
-- Explicit synthetic run IDs/times. No invented failed original40538 or payment.
INSERT INTO cron.job_run_details
SELECT CASE WHEN n=4 THEN 258 ELSE 259 END,n,NULL,'postgres','postgres',
 CASE WHEN n=5 THEN 'SELECT 1' ELSE j.command END,
 CASE WHEN n=2 THEN 'running' WHEN n=3 THEN 'succeeded' ELSE 'failed' END,
 CASE WHEN n=8 THEN repeat('é',6000) WHEN n=9 THEN NULL WHEN n=11 THEN '' ELSE 'modeled checker failure' END,
 CASE WHEN n=6 THEN timestamptz '2026-09-05T00:00Z' WHEN n IN(7,9,10) THEN NULL
   WHEN n=11 THEN timestamptz '2026-09-06T14:34:00.384087Z' ELSE timestamptz '2026-09-15T00:34Z' END,
 CASE WHEN n IN(2,9,11) THEN NULL WHEN n=10 THEN timestamptz '2026-09-05T00:01Z'
   ELSE timestamptz '2026-09-15T00:35Z' END
FROM generate_series(1,11)n CROSS JOIN cron.job j;
CREATE TEMP TABLE qualification_source_rows AS SELECT * FROM cron.job_run_details;
SET LOCAL timezone='America/Chicago';
SELECT pg_temp.assert_true(pg_temp.run_cash_intake()->>'acknowledged_snapshots'='5','only eligible failed1/7/8/9/11 imported');
SELECT pg_temp.assert_true((SELECT array_agg(event_key ORDER BY event_key)=ARRAY['259:1','259:11','259:7','259:8','259:9'] FROM public.operational_alert_events),'exact original keys exclude NULL-start known pre-cutoff end10');
SELECT pg_temp.assert_true((SELECT payload->>'time_scope'='start_unknown_end_at_or_after_received_case'
 AND payload->'internal_check_id'='null'::jsonb AND payload->'sqlstate'='null'::jsonb
 FROM public.operational_alert_events WHERE event_key='259:7'),'unknown start is not fabricated from known in-scope end');
SELECT pg_temp.assert_true((SELECT payload->>'time_scope'='start_and_end_unknown'
 AND payload#>'{original_run,start_time}'='null'::jsonb AND payload#>'{original_run,end_time}'='null'::jsonb
 AND payload->'error_text_md5'='null'::jsonb AND payload->'error_text_characters'='null'::jsonb
 FROM public.operational_alert_events WHERE event_key='259:9'),'both times and absent error text remain unknown');
SELECT pg_temp.assert_true((SELECT payload#>>'{original_run,start_time}'='2026-09-06T14:34:00.384087+00:00'
 AND payload#>'{original_run,end_time}'='null'::jsonb AND payload->>'error_text_characters'='0'
 AND payload->>'error_text_md5'=md5('')
 FROM public.operational_alert_events WHERE event_key='259:11'),'inclusive cutoff preserves UTC sub-millisecond precision and failed NULL end');
SELECT pg_temp.assert_true((SELECT length(payload#>>'{original_run,return_message}')=4096
 AND payload->>'error_text_characters'='6000' AND payload->>'error_text_bytes'='12000'
 AND payload->>'error_text_truncated'='true' AND octet_length(payload::text)<32768
 FROM public.operational_alert_events WHERE event_key='259:8'),'multibyte error cap and exact length evidence');
CREATE TEMP TABLE qualification_original_receipts AS SELECT * FROM public.operational_alert_events;
SET LOCAL timezone='Pacific/Auckland';
SELECT pg_temp.assert_true(pg_temp.run_cash_intake()->>'acknowledged_snapshots'='0','timezone-independent replay creates no receipt or delivery counter change');
SELECT pg_temp.assert_true(NOT EXISTS((SELECT * FROM public.operational_alert_events EXCEPT SELECT * FROM qualification_original_receipts)
 UNION ALL(SELECT * FROM qualification_original_receipts EXCEPT SELECT * FROM public.operational_alert_events)),'immutable replay receipts');
SELECT pg_temp.assert_true(NOT EXISTS((SELECT * FROM cron.job_run_details EXCEPT SELECT * FROM qualification_source_rows)
 UNION ALL(SELECT * FROM qualification_source_rows EXCEPT SELECT * FROM cron.job_run_details)),'reader never edits source runs');
-- Late terminal transition below already imported runid8 must not be skipped.
UPDATE cron.job_run_details SET status='failed',end_time='2026-09-15T00:36Z' WHERE runid=2;
SELECT pg_temp.assert_true(pg_temp.run_cash_intake()->>'acknowledged_snapshots'='1','lower running2 later failure retained');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.operational_alert_events WHERE event_key='259:2'),'late terminal original exists');
UPDATE cron.job_run_details SET return_message='modeled changed failed-source snapshot' WHERE runid=1;
SELECT pg_temp.assert_true(pg_temp.run_cash_intake()->>'acknowledged_snapshots'='1','source snapshot correction appended');
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and((e.payload->>'original_inbox_id'=b.id::text
 AND e.source='cash-pot-conservation-cron-failure-updates') IS TRUE)
 FROM public.operational_alert_events e JOIN qualification_original_receipts b ON b.event_key='259:1'
 WHERE e.event_key LIKE '259:1:%'),'update linked to exact original receipt');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM qualification_original_receipts b LEFT JOIN public.operational_alert_events e USING(id)
 WHERE to_jsonb(e) IS DISTINCT FROM to_jsonb(b)),'later source changes preserve every earlier receipt');
-- Fixed batch bound must not abandon record101 or terminal rows outside a cursor.
INSERT INTO cron.job_run_details SELECT 259,n,NULL,'postgres','postgres',j.command,'failed','modeled batch failure','2026-09-15T00:34Z','2026-09-15T00:35Z'
FROM generate_series(1000,1100)n CROSS JOIN cron.job j;
SELECT pg_temp.assert_true(pg_temp.run_cash_intake() @> '{"acknowledged_snapshots":100,"more_retained_failures":true,"cursor_advanced":false}'::jsonb,'100 cap preserves additional work');
SELECT pg_temp.assert_true(pg_temp.run_cash_intake() @> '{"acknowledged_snapshots":1,"more_retained_failures":false,"historical_retention_complete":false}'::jsonb,'remaining101 imported without false retention proof');
SELECT pg_temp.assert_true(pg_temp.run_cash_intake()->>'acknowledged_snapshots'='0','all retained fixtures now acknowledged');
SAVEPOINT malformed_receipt;
UPDATE public.operational_alert_events SET status='info' WHERE event_key='259:1';
SELECT pg_temp.assert_refused('corrupt existing acknowledgement');
ROLLBACK TO malformed_receipt;
SAVEPOINT invalid_receipt_id;
UPDATE public.operational_alert_events SET id=-8 WHERE event_key='259:8';
SELECT pg_temp.assert_refused('corrupt existing acknowledgement');
ROLLBACK TO invalid_receipt_id;
SAVEPOINT payload_corruption;
UPDATE public.operational_alert_events SET payload=jsonb_set(payload,'{original_run,return_message}','"corrupted"') WHERE event_key='259:1';
SELECT pg_temp.assert_refused('corrupt existing acknowledgement');
ROLLBACK TO payload_corruption;
SAVEPOINT truncated_prefix_corruption;
UPDATE public.operational_alert_events SET payload=jsonb_set(payload,'{original_run,return_message}',to_jsonb(repeat('x',4096))) WHERE event_key='259:8';
SELECT pg_temp.assert_refused('retained snapshot payload mismatch');
ROLLBACK TO truncated_prefix_corruption;
SAVEPOINT truncated_metadata_corruption;
UPDATE public.operational_alert_events SET payload=jsonb_set(payload,'{error_text_bytes}','12001') WHERE event_key='259:8';
SELECT pg_temp.assert_refused('retained snapshot payload mismatch');
ROLLBACK TO truncated_metadata_corruption;
SAVEPOINT wrong_update_parent;
UPDATE public.operational_alert_events e SET payload=jsonb_set(e.payload,'{original_inbox_id}',to_jsonb(b.id))
FROM public.operational_alert_events b WHERE e.source='cash-pot-conservation-cron-failure-updates' AND b.event_key='259:7';
SELECT pg_temp.assert_refused('corrupt existing acknowledgement');
ROLLBACK TO wrong_update_parent;
SAVEPOINT orphan_update_parent;
DELETE FROM public.operational_alert_events WHERE event_key='259:1';
SELECT pg_temp.assert_refused('corrupt existing acknowledgement');
ROLLBACK TO orphan_update_parent;
SAVEPOINT original_has_parent;
UPDATE public.operational_alert_events SET payload=jsonb_set(payload,'{original_inbox_id}',to_jsonb(id)) WHERE event_key='259:8';
SELECT pg_temp.assert_refused('corrupt existing acknowledgement');
ROLLBACK TO original_has_parent;
SAVEPOINT source_retention;
DELETE FROM cron.job_run_details WHERE runid=8;
SELECT pg_temp.assert_true(pg_temp.run_cash_intake() @> '{"acknowledged_snapshots":0,"historical_retention_complete":false}'::jsonb,
 'purged long source is not reconstructed or treated as complete history');
SELECT pg_temp.assert_true((SELECT e.payload=b.payload FROM public.operational_alert_events e
 JOIN qualification_original_receipts b USING(id) WHERE e.event_key='259:8'),'purge never alters retained evidence');
ROLLBACK TO source_retention;
SAVEPOINT job_drift;
UPDATE cron.job SET schedule='* * * * *';
SELECT pg_temp.assert_refused('checker job contract drift');
ROLLBACK TO job_drift;
SAVEPOINT job_host_drift;
UPDATE cron.job SET nodename='other-server';
SELECT pg_temp.assert_refused('checker job contract drift');
ROLLBACK TO job_host_drift;
SAVEPOINT job_port_drift;
UPDATE cron.job SET nodeport=5433;
SELECT pg_temp.assert_refused('checker job contract drift');
ROLLBACK TO job_port_drift;
SAVEPOINT writer_drift;
GRANT EXECUTE ON FUNCTION public.fn_record_operational_alert(text,text,text,text,text,jsonb) TO anon;
SELECT pg_temp.assert_refused('exact queue writer authority required');
ROLLBACK TO writer_drift;
-- Queue refusal must roll back the whole batch and allow retry. It must never
-- be labeled a committed cron receipt merely because the producer failed.
CREATE FUNCTION pg_temp.deny_cash_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.event_key='259:2001' THEN
  PERFORM pg_temp.assert_true(EXISTS(SELECT 1 FROM public.operational_alert_events WHERE event_key='259:2000'),
   'first batch write occurred before second-write refusal');
  RAISE EXCEPTION 'modeled queue unavailable after first write';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER qualification_queue_down BEFORE INSERT ON public.operational_alert_events FOR EACH ROW EXECUTE FUNCTION pg_temp.deny_cash_receipt();
INSERT INTO cron.job_run_details SELECT 259,n,NULL,'postgres','postgres',j.command,'failed','modeled retry failure','2026-09-15T00:34Z','2026-09-15T00:35Z'
FROM generate_series(2000,2001)n CROSS JOIN cron.job j;
CREATE TEMP TABLE qualification_before_refusal AS SELECT * FROM public.operational_alert_events;
SELECT pg_temp.assert_refused('modeled queue unavailable after first write');
SELECT pg_temp.assert_true(NOT EXISTS(SELECT 1 FROM public.operational_alert_events WHERE event_key IN('259:2000','259:2001')),'second-write failure rolls back both new receipts');
SELECT pg_temp.assert_true(NOT EXISTS((SELECT * FROM public.operational_alert_events EXCEPT SELECT * FROM qualification_before_refusal)
 UNION ALL(SELECT * FROM qualification_before_refusal EXCEPT SELECT * FROM public.operational_alert_events)),'failed batch preserves every prior queue row');
DROP TRIGGER qualification_queue_down ON public.operational_alert_events;
SELECT pg_temp.assert_true(pg_temp.run_cash_intake()->>'acknowledged_snapshots'='2','both failed runs remain retryable');
-- The initial guard sees valid originals. The trigger then redirects a new
-- attempted key to a valid old key, exercising the real writer's conflict arm
-- with a different payload. Strict write readback must reject and undo its
-- delivery-counter/timestamp update, not merely return the old positive ID.
CREATE FUNCTION pg_temp.collide_cash_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.event_key='259:2100' THEN NEW.event_key:='259:1'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER qualification_late_collision BEFORE INSERT ON public.operational_alert_events FOR EACH ROW EXECUTE FUNCTION pg_temp.collide_cash_receipt();
INSERT INTO cron.job_run_details SELECT 259,2100,NULL,'postgres','postgres',j.command,'failed','modeled colliding failure','2026-09-15T00:34Z','2026-09-15T00:35Z' FROM cron.job j;
CREATE TEMP TABLE qualification_before_collision AS SELECT * FROM public.operational_alert_events;
SELECT pg_temp.assert_refused('immutable receipt mismatch for run 2100');
SELECT pg_temp.assert_true(NOT EXISTS((SELECT * FROM public.operational_alert_events EXCEPT SELECT * FROM qualification_before_collision)
 UNION ALL(SELECT * FROM qualification_before_collision EXCEPT SELECT * FROM public.operational_alert_events)),'collision leaves original payload and delivery counter unchanged');
DROP TRIGGER qualification_late_collision ON public.operational_alert_events;
SELECT pg_temp.assert_true(pg_temp.run_cash_intake()->>'acknowledged_snapshots'='1','colliding original remains retryable');
-- Single-session interleaving model, not an actual concurrent-session proof:
-- after the cursor selects a pair, the first insert supplies the second exact
-- original before its parent lookup. It must not become a redundant update.
CREATE FUNCTION pg_temp.supply_next_cash_original() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_original jsonb; v_text text;
BEGIN
 IF NEW.event_key='259:3000' THEN
  SELECT to_jsonb(r),r.return_message INTO v_original,v_text FROM cron.job_run_details r WHERE runid=3001;
  INSERT INTO public.operational_alert_events(source,event_key,alertname,status,severity,payload)
  VALUES(NEW.source,'259:3001',NEW.alertname,NEW.status,NEW.severity,
   NEW.payload||jsonb_build_object('original_run',v_original||jsonb_build_object('return_message',left(v_text,4096)),
    'original_run_md5',md5(v_original::text),'error_text_characters',length(v_text),
    'error_text_bytes',octet_length(v_text),'error_text_md5',md5(v_text),
    'error_text_truncated',coalesce(length(v_text)>4096,false)));
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER qualification_visible_parent AFTER INSERT ON public.operational_alert_events FOR EACH ROW EXECUTE FUNCTION pg_temp.supply_next_cash_original();
INSERT INTO cron.job_run_details SELECT 259,n,NULL,'postgres','postgres',j.command,'failed','modeled identical interleaving','2026-09-15T00:34Z','2026-09-15T00:35Z'
FROM generate_series(3000,3001)n CROSS JOIN cron.job j;
SELECT pg_temp.assert_true(pg_temp.run_cash_intake()->>'acknowledged_snapshots'='2','selected pair acknowledges two snapshots even when one original appears before parent lookup');
SELECT pg_temp.assert_true((SELECT count(*)=2 AND bool_and((source='cash-pot-conservation-cron-failure') IS TRUE)
 FROM public.operational_alert_events WHERE payload#>>'{original_run,runid}' IN('3000','3001')),'identical visible parent creates no redundant update');
SELECT pg_temp.assert_true((SELECT delivery_count=2 FROM public.operational_alert_events WHERE event_key='259:3001'),
 'interleaving actually reached the identical-original conflict path');
DROP TRIGGER qualification_visible_parent ON public.operational_alert_events;
SELECT pg_temp.assert_true(pg_temp.run_cash_intake()->>'acknowledged_snapshots'='0','interleaved original passes full retained-payload replay checks');
SELECT 'cash-pot-failed-run-intake' AS scope,current_setting('operational.cash_failed_intake_result')::jsonb AS last_receipt;
ROLLBACK;
DO $cleanup$
BEGIN
 IF to_regnamespace('cron') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace)
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace) THEN RAISE EXCEPTION 'private cash-failure fixture cleanup incomplete'; END IF;
END;
$cleanup$;
-- SQL rollback alone is not proof of stopped/empty provider allocation.
