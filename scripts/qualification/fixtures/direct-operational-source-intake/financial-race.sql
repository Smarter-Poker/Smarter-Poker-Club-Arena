\set ON_ERROR_STOP on
BEGIN;
SET LOCAL timezone='UTC';
SET LOCAL search_path=public,pg_temp;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
SELECT set_config('application_name',:'race_application',true);
SELECT 'DIRECT_BACKEND:'||pg_backend_pid();
CREATE FUNCTION pg_temp.race_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'direct financial race: %',label; END IF; END $$;
SELECT pg_temp.race_assert(current_user='postgres' AND session_user='postgres'
 AND current_database()='qual_owner_notify_'||replace(:'execution_uuid','-','')
 AND inet_server_addr() IS NULL AND :'race_case'='financial_first'
 AND :'race_side' IN ('holder','waiter','verify'), 'exact isolated session/case');
CREATE TEMP TABLE race_id AS SELECT extensions.uuid_generate_v5(:'execution_uuid'::uuid,'direct-financial-race') id;
SELECT :'race_side'='holder' AS holder, :'race_side'='verify' AS verify \gset
\if :verify
 SELECT pg_temp.race_assert((SELECT count(*)=1 AND bool_and((message='accepted actual source update') IS TRUE)
 FROM financial_alerts WHERE id=(SELECT id FROM race_id)), 'financial source outcome committed');
 SELECT pg_temp.race_assert((SELECT count(*)=2 AND count(*) FILTER(WHERE d.state='pending'
 AND d.inbox_event_id IS NULL AND d.last_error='P0001:operational source exact receipt collision')=1
 AND count(*) FILTER(WHERE d.state='captured')=1 FROM operational_source_intake.snapshots s
 JOIN operational_source_intake.deliveries d USING(snapshot_id) WHERE s.source_id=(SELECT id::text FROM race_id)),
 'racing old envelope causes explicit pending; actual new snapshot captured');
 SELECT pg_temp.race_assert((SELECT count(*)=1 AND bool_and((e.payload->'original_event'=s.original_row
 AND NOT(e.payload ? 'target_task_id') AND s.first_observed AND s.observation='update_old') IS TRUE)
 FROM operational_alert_events e JOIN operational_source_intake.snapshots s ON s.source_id=e.event_key
 WHERE e.source='financial-alerts-backfill' AND s.first_observed AND s.source_id=(SELECT id::text FROM race_id)),
 'finite-reader original is unchanged and bound to the complete old snapshot');
 SELECT pg_temp.race_assert((SELECT count(*)=1 AND bool_and((e.payload->'original_event'=to_jsonb(f)
 AND e.payload->>'target_task_id'='01a09b86-5ba8-7290-8657-1041f13dd3ca'
 AND e.payload->>'original_inbox_id'=o.id::text) IS TRUE)
 FROM financial_alerts f JOIN operational_alert_events e ON e.event_key=f.id::text||':'||md5(to_jsonb(f)::text)
 JOIN operational_alert_events o ON o.source='financial-alerts-backfill' AND o.event_key=f.id::text
 WHERE e.source='financial-alerts-updates' AND f.id=(SELECT id FROM race_id)), 'full new capture links the exact old original');
 -- Leave the old snapshot pending on purpose: retaining rollback must keep it.
 COMMIT;
\else
 \if :holder
  SELECT fn_record_operational_alert('financial-alerts-backfill',f.id::text,f.source,'firing',f.severity,
   jsonb_build_object('original_event',to_jsonb(f),'captured_at',clock_timestamp(),
   'backfill_window_start','2026-09-01T00:00:00Z')) FROM financial_alerts f WHERE id=(SELECT id FROM race_id);
  \echo DIRECT_HOLDER_READY
 \else
  UPDATE financial_alerts SET message='accepted actual source update' WHERE id=(SELECT id FROM race_id);
  COMMIT;
 \endif
\endif
