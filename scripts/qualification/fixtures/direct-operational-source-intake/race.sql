-- Actual separate psql sessions, supervised by the existing required runner.
-- The holder leaves its transaction open until the runner proves the waiter
-- is blocked by this exact backend, then supplies COMMIT on its stdin.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL timezone='UTC';
SET LOCAL search_path=public,pg_temp;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
SELECT set_config('application_name',:'race_application',true);
SELECT 'DIRECT_BACKEND:'||pg_backend_pid();
CREATE FUNCTION pg_temp.race_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'direct source race: %',label; END IF; END $$;
SELECT pg_temp.race_assert(current_user='postgres' AND session_user='postgres'
 AND current_database()='qual_owner_notify_'||replace(:'execution_uuid','-','')
 AND inet_server_addr() IS NULL AND :'race_case' IN ('finite_first','capture_first','reversed_batch')
 AND :'race_side' IN ('holder','waiter','verify'), 'exact isolated session/case');
CREATE TEMP TABLE race_rows AS
SELECT a.id,to_jsonb(a) original_row,r.event_id,r.payload
FROM engine_alerts a JOIN engine_alert_delivery_receipts r ON r.engine_alert_id=a.id
WHERE (:'race_case'='finite_first' AND a.alertname='DirectRaceFinite')
 OR (:'race_case'='capture_first' AND a.alertname='DirectRaceCapture')
 OR (:'race_case'='reversed_batch' AND a.alertname IN ('DirectRaceBatch1','DirectRaceBatch2'));
SELECT pg_temp.race_assert((SELECT count(*)=CASE WHEN :'race_case'='reversed_batch' THEN 2 ELSE 1 END
 AND bool_and((event_id=extensions.uuid_generate_v5(:'execution_uuid'::uuid,'direct-'||
 substring(original_row->>'alertname' FROM 11))) IS TRUE) FROM race_rows), 'exact preexisting producer identities');
SELECT :'race_side'='holder' AS holder, :'race_side'='verify' AS verify,
 ((:'race_case'='finite_first' AND :'race_side'='holder') OR
  (:'race_case'='capture_first' AND :'race_side'='waiter')) AS finite_reader \gset
\if :verify
 -- A separate transaction proves the original winner and full row remain.
 SELECT pg_temp.race_assert((SELECT count(*)=(SELECT count(*) FROM race_rows)
 AND bool_and((e.payload->'original_event'=r.original_row AND e.alertname=r.original_row->>'alertname'
 AND e.status='firing' AND e.severity='warning') IS TRUE)
 FROM operational_alert_events e JOIN race_rows r ON e.event_key=r.id::text
 WHERE e.source='engine-alerts-backfill'), 'one exact inbox original for each producer');
 SELECT pg_temp.race_assert(NOT EXISTS(SELECT 1 FROM operational_alert_events e JOIN race_rows r
 ON e.event_key LIKE r.id::text||':%' WHERE e.source='engine-alerts-updates'), 'no invented update');
 SELECT pg_temp.race_assert((SELECT bool_and((CASE WHEN :'race_case'='finite_first'
 THEN NOT(e.payload ? 'target_task_id') AND e.payload->>'backfill_window_start'='2026-09-01T00:00:00Z'
 ELSE e.payload->>'target_task_id'='01a09b86-5ba8-7290-8657-1041f13dd3ca' END) IS TRUE)
 FROM operational_alert_events e JOIN race_rows r ON e.event_key=r.id::text
 WHERE e.source='engine-alerts-backfill'), 'winning envelope retained without task mutation');
 CREATE TEMP TABLE race_before AS SELECT to_jsonb(e) full_row FROM operational_alert_events e
 JOIN race_rows r ON e.event_key=r.id::text WHERE e.source='engine-alerts-backfill';
 -- Finite-first deliberately failed the in-flight strict ACK after its old
 -- envelope won. A new explicit replay may recognize that retained envelope.
 SELECT pg_temp.race_assert(fn_record_engine_alerts((SELECT jsonb_agg(payload ORDER BY id) FROM race_rows))=
 (SELECT jsonb_agg(jsonb_build_object('id',id,'event_id',event_id) ORDER BY id) FROM race_rows),
 'explicit replay returns exact original public receipts');
 SELECT pg_temp.race_assert((SELECT jsonb_agg(full_row ORDER BY full_row->>'id') FROM race_before)=
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id::text) FROM operational_alert_events e
 JOIN race_rows r ON e.event_key=r.id::text WHERE e.source='engine-alerts-backfill'),
 'explicit replay preserves entire retained inbox rows');
 COMMIT;
\else
 \if :finite_reader
  -- Literal existing finite-reader envelope: no new target marker is invented.
  SELECT fn_record_operational_alert('engine-alerts-backfill',id::text,original_row->>'alertname',
   original_row->>'status',original_row->>'severity',jsonb_build_object('original_event',original_row,
   'captured_at',clock_timestamp(),'backfill_window_start','2026-09-01T00:00:00Z')) FROM race_rows;
 \else
  -- Reverse B's two-event input; the real producer function still takes its
  -- original ordered advisory locks. The fixture never replaces that function.
  SELECT pg_temp.race_assert(fn_record_engine_alerts((SELECT jsonb_agg(payload ORDER BY
   CASE WHEN :'race_side'='waiter' THEN -id ELSE id END) FROM race_rows))=
   (SELECT jsonb_agg(jsonb_build_object('id',id,'event_id',event_id) ORDER BY
   CASE WHEN :'race_side'='waiter' THEN -id ELSE id END) FROM race_rows), 'exact ordered batch acknowledgement');
 \endif
 \if :holder
  \echo DIRECT_HOLDER_READY
 \else
  COMMIT;
 \endif
\endif
