-- SOURCE ONLY / UNRUN. Invoked by the existing production-alert-core PG17 job
-- after current captured engine catalog and the actual guarded component.
-- All case mutations roll back; no payment, real user, sender, or scheduler.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='3s';
SET LOCAL timezone='UTC';
SET LOCAL search_path=public,pg_temp;
CREATE TEMP TABLE direct_inputs AS SELECT :'execution_uuid'::uuid execution;
CREATE FUNCTION pg_temp.direct_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'direct source qualification: %',label; END IF; END $$;
SELECT pg_temp.direct_assert(current_user='postgres' AND session_user='postgres'
 AND current_database()='qual_owner_notify_'||replace(execution::text,'-','')
 AND inet_server_addr() IS NULL AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999,
 'exact existing disposable PG17 allocation') FROM direct_inputs;
SELECT pg_temp.direct_assert(to_regclass('operational_source_intake.snapshots') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM operational_source_intake.snapshots), 'new empty capture store');
CREATE TEMP TABLE direct_originals AS SELECT
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM operational_alert_events e) inbox;
CREATE FUNCTION pg_temp.direct_expect(sql text,state text,fragment text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text; msg text;
BEGIN
 BEGIN EXECUTE sql;
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got=RETURNED_SQLSTATE,msg=MESSAGE_TEXT; END;
 IF got IS DISTINCT FROM state OR position(fragment IN coalesce(msg,''))=0
 THEN RAISE EXCEPTION 'direct source qualification: expected % / %, got % / %',state,fragment,got,msg; END IF;
END $$;
-- Only the exact three intended row hooks may be excluded from the retained
-- baseline during postimage/rollback authority comparison.
\ir ../../supabase/components/direct-operational-source-intake.authority.sql
SELECT pg_temp.assert_direct_source_authority('3b97b07170b81947137ee2adfc268717',true);
SAVEPOINT foreign_inbox_hook;
CREATE TRIGGER a00_operational_source_intake AFTER INSERT OR UPDATE ON operational_alert_events
 FOR EACH ROW EXECUTE FUNCTION public.fn_capture_operational_source_event();
SELECT pg_temp.direct_expect($q$SELECT pg_temp.assert_direct_source_authority('3b97b07170b81947137ee2adfc268717',true)$q$,
 'P0001','current catalog authority differs');
ROLLBACK TO foreign_inbox_hook;
SAVEPOINT foreign_receipt_hook;
CREATE TRIGGER a00_operational_source_intake AFTER INSERT OR UPDATE ON engine_alert_delivery_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_capture_operational_source_event();
SELECT pg_temp.direct_expect($q$SELECT pg_temp.assert_direct_source_authority('3b97b07170b81947137ee2adfc268717',true)$q$,
 'P0001','current catalog authority differs');
ROLLBACK TO foreign_receipt_hook;
CREATE TEMP TABLE direct_ids(label text PRIMARY KEY,id uuid NOT NULL);
-- The pre-component receipt is committed by prepare. Replay must now establish
-- exact inbox capture; merely returning the old engine receipt is a negative.
SAVEPOINT old_receipt_queue_failure;
ALTER TABLE operational_alert_events ADD CONSTRAINT direct_old_receipt_queue_outage CHECK(source<>'engine-alerts-backfill') NOT VALID;
SELECT pg_temp.direct_expect(format('SELECT fn_record_engine_alerts(%L::jsonb)',jsonb_build_array(
 jsonb_build_object('status','firing','labels',jsonb_build_object('alertname','DirectSourceLegacy',
 'severity','warning','engine_alert_event_id',execution)))), '23514','direct_old_receipt_queue_outage') FROM direct_inputs;
SELECT pg_temp.direct_assert((SELECT count(*)=6 FROM engine_alert_delivery_receipts)
 AND NOT EXISTS(SELECT 1 FROM operational_alert_events WHERE source='engine-alerts-backfill'),
 'old producer receipt cannot acknowledge a failed inbox capture');
ROLLBACK TO old_receipt_queue_failure;
CREATE TEMP TABLE direct_engine AS SELECT public.fn_record_engine_alerts(jsonb_build_array(
 jsonb_build_object('status','firing','labels',jsonb_build_object('alertname','DirectSourceLegacy',
 'severity','warning','engine_alert_event_id',execution)))) receipt FROM direct_inputs;
SELECT pg_temp.direct_assert((SELECT count(*)=1 FROM engine_alerts WHERE alertname='DirectSourceLegacy')
 AND (SELECT count(*)=1 FROM operational_alert_events WHERE source='engine-alerts-backfill'
 AND event_key=(SELECT receipt->0->>'id' FROM direct_engine)), 'old producer replay establishes exact inbox original');
SELECT pg_temp.direct_assert((SELECT public.fn_read_operational_source_snapshot(e.id)=to_jsonb(a)
 FROM operational_alert_events e JOIN engine_alerts a ON e.event_key=a.id::text
 WHERE e.source='engine-alerts-backfill' AND a.alertname='DirectSourceLegacy'), 'engine complete row, classification and task receipt');
SELECT pg_temp.direct_assert(public.fn_record_engine_alerts(jsonb_build_array(
 jsonb_build_object('status','firing','labels',jsonb_build_object('alertname','DirectSourceLegacy',
 'severity','warning','engine_alert_event_id',execution))))=(SELECT receipt FROM direct_engine),
 'exact engine replay preserves public receipt') FROM direct_inputs;
SELECT pg_temp.direct_expect(format('SELECT fn_record_engine_alerts(%L::jsonb)',jsonb_build_array(
 jsonb_build_object('status','resolved','labels',jsonb_build_object('alertname','DirectSourceLegacy',
 'severity','warning','engine_alert_event_id',execution)))), '23505','different payload') FROM direct_inputs;
SET LOCAL timezone='America/Chicago';
SELECT pg_temp.direct_assert(public.fn_record_engine_alerts(jsonb_build_array(
 jsonb_build_object('status','firing','labels',jsonb_build_object('alertname','DirectSourceLegacy',
 'severity','warning','engine_alert_event_id',execution))))=(SELECT receipt FROM direct_engine),
 'replay in another session zone uses the same UTC original') FROM direct_inputs;
SELECT pg_temp.direct_assert(NOT EXISTS(SELECT 1 FROM operational_alert_events WHERE source='engine-alerts-updates'),
 'timestamp representation does not invent a replay update');
SET LOCAL timezone='UTC';
SAVEPOINT engine_update;
UPDATE engine_alerts SET summary='changed actual row' WHERE alertname='DirectSourceLegacy';
SELECT pg_temp.direct_assert((SELECT count(*)=1 FROM operational_alert_events WHERE source='engine-alerts-updates'
 AND payload->'original_event'->>'summary'='changed actual row'),'changed engine row retains original and exact update');
UPDATE engine_alerts SET summary=summary WHERE alertname='DirectSourceLegacy';
SELECT pg_temp.direct_assert((SELECT count(*)=1 FROM operational_alert_events WHERE source='engine-alerts-updates'),'no-op source update emits no extra receipt');
ROLLBACK TO engine_update;

INSERT INTO engine_alerts(fingerprint,alertname,status,severity) VALUES('direct-info','DirectSourceInfo','info','info');
SELECT pg_temp.direct_assert(EXISTS(SELECT 1 FROM operational_alert_events WHERE source='engine-alerts-backfill'
 AND alertname='DirectSourceInfo' AND status='info'), 'existing legitimate direct engine info status is preserved');

-- The accepted RPC is below its existing bound, but component appears both in
-- labels and the source column, making the exact source envelope oversized.
CREATE TEMP TABLE direct_large_engine AS SELECT jsonb_build_array(jsonb_build_object('status','firing',
 'labels',jsonb_build_object('alertname','DirectSourceLargeEngine','severity','warning',
 'component',repeat('x',140000),'engine_alert_event_id',extensions.uuid_generate_v5(execution,'direct-large-engine')))) payload
 FROM direct_inputs;
SELECT pg_temp.direct_assert((SELECT pg_column_size(payload)<=262144 FROM direct_large_engine),
 'oversized row example is an admitted unchanged producer RPC');
SAVEPOINT strict_engine_storage_failure;
ALTER TABLE operational_source_intake.snapshots ADD CONSTRAINT direct_engine_storage_failure CHECK(source_kind<>'engine') NOT VALID;
SELECT pg_temp.direct_expect(format('SELECT fn_record_engine_alerts(%L::jsonb)',payload),'23514','direct_engine_storage_failure') FROM direct_large_engine;
SELECT pg_temp.direct_assert(NOT EXISTS(SELECT 1 FROM engine_alerts WHERE alertname='DirectSourceLargeEngine')
 AND NOT EXISTS(SELECT 1 FROM engine_alert_delivery_receipts WHERE event_id=extensions.uuid_generate_v5((SELECT execution FROM direct_inputs),'direct-large-engine')),
 'strict engine storage failure rolls back source and producer ACK');
ROLLBACK TO strict_engine_storage_failure;
SAVEPOINT strict_engine_reference_failure;
ALTER TABLE operational_alert_events ADD CONSTRAINT direct_engine_reference_failure
 CHECK(alertname<>'DirectSourceLargeEngine') NOT VALID;
SELECT pg_temp.direct_expect(format('SELECT fn_record_engine_alerts(%L::jsonb)',payload),'23514','direct_engine_reference_failure') FROM direct_large_engine;
SELECT pg_temp.direct_assert(NOT EXISTS(SELECT 1 FROM engine_alerts WHERE alertname='DirectSourceLargeEngine')
 AND NOT EXISTS(SELECT 1 FROM operational_source_intake.snapshots WHERE source_kind='engine')
 AND NOT EXISTS(SELECT 1 FROM engine_alert_delivery_receipts WHERE event_id=extensions.uuid_generate_v5((SELECT execution FROM direct_inputs),'direct-large-engine')),
 'failed reference capture rolls back the complete engine snapshot, source and ACK');
ROLLBACK TO strict_engine_reference_failure;
CREATE TEMP TABLE direct_large_receipt AS SELECT fn_record_engine_alerts(payload) receipt FROM direct_large_engine;
SELECT pg_temp.direct_assert((SELECT count(*)=1 AND bool_and((octet_length(to_jsonb(a)::text)>262144
 AND octet_length(e.payload::text)<=262144 AND NOT(e.payload ? 'original_event')
 AND e.payload->>'evidence_storage'='immutable_reference' AND s.source_kind='engine'
 AND s.original_row=to_jsonb(a) AND fn_read_operational_source_snapshot(e.id)=to_jsonb(a)
 AND d.state='captured' AND d.inbox_event_id=e.id) IS TRUE)
 FROM engine_alerts a JOIN operational_alert_events e ON e.source='engine-alerts-backfill' AND e.event_key=a.id::text
 JOIN operational_source_intake.snapshots s ON s.snapshot_id=(e.payload->'evidence_reference'->>'snapshot_id')::uuid
 JOIN operational_source_intake.deliveries d USING(snapshot_id) WHERE a.alertname='DirectSourceLargeEngine'),
 'whole expanded engine row has strict immutable reference and exact captured receipt');
SELECT pg_temp.direct_assert(fn_record_engine_alerts(payload)=(SELECT receipt FROM direct_large_receipt),
 'oversized engine exact replay preserves original ACK') FROM direct_large_engine;
SELECT pg_temp.direct_assert((SELECT count(*)=1 FROM operational_source_intake.snapshots WHERE source_kind='engine')
 AND (SELECT count(*)=1 FROM operational_alert_events WHERE alertname='DirectSourceLargeEngine'),
 'oversized engine replay creates no duplicate snapshot or inbox event');

SAVEPOINT late_engine_batch_failure;
ALTER TABLE operational_alert_events ADD CONSTRAINT direct_late_engine_failure
 CHECK(payload->'original_event'->>'alertname' IS DISTINCT FROM 'DirectLateFail') NOT VALID;
SELECT pg_temp.direct_expect($q$SELECT fn_record_engine_alerts('[{"status":"firing","labels":{"alertname":"DirectEarlyPass"}},
 {"status":"firing","labels":{"alertname":"DirectLateFail"}}]')$q$, '23514','direct_late_engine_failure');
SELECT pg_temp.direct_assert(NOT EXISTS(SELECT 1 FROM engine_alerts WHERE alertname IN ('DirectEarlyPass','DirectLateFail'))
 AND NOT EXISTS(SELECT 1 FROM operational_alert_events WHERE alertname IN ('DirectEarlyPass','DirectLateFail')),
 'a later inbox failure rolls back earlier source and inbox members of the same batch');
ROLLBACK TO late_engine_batch_failure;

-- Actual server producer, real financial trigger and same exact dedupe RPC.
SET LOCAL ROLE service_role;
SELECT public.fn_raise_server_financial_alert('warning','direct-source-warning','native source warning',
 jsonb_build_object('check','direct'),'direct-source-warning',NULL) AS direct_warning \gset
RESET ROLE;
INSERT INTO direct_ids VALUES('warning',:'direct_warning'::uuid);
SELECT pg_temp.direct_assert((SELECT count(*)=1 FROM operational_alert_events WHERE source='financial-alerts-backfill'
 AND event_key=:'direct_warning'), 'all severity source capture is connected');
SET LOCAL ROLE service_role;
SELECT public.fn_raise_server_financial_alert('warning','direct-source-warning','native source warning',
 jsonb_build_object('check','direct'),'direct-source-warning',NULL) AS direct_warning_repeat \gset
RESET ROLE;
SELECT pg_temp.direct_assert(:'direct_warning_repeat'=:'direct_warning'
 AND (SELECT count(*)=1 FROM operational_alert_events WHERE source='financial-alerts-backfill'
 AND event_key=:'direct_warning'), 'existing producer dedupe identity retains its exact original receipt');
INSERT INTO financial_alerts(severity,source,message,context) VALUES('critical','postHandTasks.leave_pending_failed',
 'Native direct source connected trigger case',jsonb_build_object('table_id','10000000-0000-4000-8000-000000000001',
 'hand_number',17,'error','supabase_timeout','club_id','fade0000-0000-0000-0000-000000000001','amount',12))
 RETURNING id AS direct_critical \gset
INSERT INTO direct_ids VALUES('critical',:'direct_critical'::uuid);
SELECT pg_temp.direct_assert((SELECT count(*)=1 FROM ca_drift_incidents WHERE metadata->>'alert_id'=:'direct_critical')
 AND (SELECT count(*)=1 FROM operational_alert_events WHERE source='financial-alerts-backfill' AND event_key=:'direct_critical')
 AND (SELECT count(*)=1 FROM operational_alert_events e JOIN ca_drift_incidents i ON e.event_key=i.id::text
 WHERE e.source='drift-incidents-backfill' AND i.metadata->>'alert_id'=:'direct_critical'),
 'real financial bridge admitted one actual drift and both source originals');
SELECT pg_temp.direct_expect(format('UPDATE ca_drift_incidents SET status=''resolved'' WHERE metadata->>''alert_id''=%L',
 :'direct_critical'),'P0404','cause is written down');
SELECT pg_temp.direct_assert(NOT EXISTS(SELECT 1 FROM operational_alert_events e WHERE e.source='drift-incidents-updates'
 AND e.payload->'original_incident'->>'status'='resolved'), 'rejected resolution creates no captured transition');
UPDATE ca_drift_incidents SET occurrences=occurrences+1 WHERE metadata->>'alert_id'=:'direct_critical';
UPDATE ca_drift_incidents SET occurrences=occurrences+1 WHERE metadata->>'alert_id'=:'direct_critical';
SELECT pg_temp.direct_assert((SELECT count(*)=2 AND count(DISTINCT payload->'original_incident'->>'occurrences')=2
 FROM operational_alert_events WHERE source='drift-incidents-updates'
 AND payload->'original_incident'->'metadata'->>'alert_id'=:'direct_critical'), 'two occurrence changes preserve both complete snapshots');
UPDATE financial_alerts SET resolved=true,resolved_at=clock_timestamp(),resolution='native fixture resolution, no money moved'
 WHERE id=:'direct_critical'::uuid;
SELECT pg_temp.direct_assert((SELECT status='resolved' FROM ca_drift_incidents WHERE metadata->>'alert_id'=:'direct_critical')
 AND EXISTS(SELECT 1 FROM operational_alert_events WHERE source='financial-alerts-updates'
 AND event_key LIKE :'direct_critical'||':%' AND status='resolved')
 AND EXISTS(SELECT 1 FROM operational_alert_events WHERE source='drift-incidents-updates'
 AND payload->'original_incident'->'metadata'->>'alert_id'=:'direct_critical' AND status='resolved'),
 'actual nested financial to drift resolution keeps both source transitions');
SELECT pg_temp.direct_assert(NOT EXISTS(SELECT 1 FROM operational_alert_events e
 WHERE e.source IN ('financial-alerts-backfill','financial-alerts-updates','drift-incidents-backfill','drift-incidents-updates')
 AND e.investigation_status<>'new'), 'source resolution never closes an investigation');

-- Reject inbox INSERTs with a test-owned CHECK; leave actual recorder intact.
SAVEPOINT queue_outage;
ALTER TABLE operational_alert_events ADD CONSTRAINT direct_test_queue_outage CHECK(source='unreachable-direct-test') NOT VALID;
SELECT pg_temp.direct_expect($q$SELECT fn_record_engine_alerts('[{"status":"firing","labels":{"alertname":"DirectSourceMustRollback"}}]')$q$,
 '23514','direct_test_queue_outage');
SELECT pg_temp.direct_assert(NOT EXISTS(SELECT 1 FROM engine_alerts WHERE alertname='DirectSourceMustRollback'),
 'engine failure rolls back source rather than acknowledging a missing inbox');
INSERT INTO financial_alerts(id,severity,source,message) VALUES('ea100000-0000-4000-8000-000000000001','warning','direct-pending','complete pending evidence');
SELECT pg_temp.direct_assert(EXISTS(SELECT 1 FROM financial_alerts WHERE id='ea100000-0000-4000-8000-000000000001')
 AND (SELECT count(*)=1 AND bool_and((d.state='pending' AND d.inbox_event_id IS NULL AND d.last_error LIKE '23514:%') IS TRUE)
 FROM operational_source_intake.snapshots s JOIN operational_source_intake.deliveries d USING(snapshot_id)
 WHERE s.source_id='ea100000-0000-4000-8000-000000000001'), 'inbox failure preserves source, full original, explicit pending error');
ALTER TABLE operational_alert_events DROP CONSTRAINT direct_test_queue_outage;
SELECT pg_temp.direct_assert((public.fn_retry_operational_source_snapshot(snapshot_id)->>'state')='captured',
 'explicit exact snapshot retry captures without financial replay') FROM operational_source_intake.snapshots
 WHERE source_id='ea100000-0000-4000-8000-000000000001';
ROLLBACK TO queue_outage;

-- Full oversized evidence is referenced, never truncated or called inline.
INSERT INTO financial_alerts(id,severity,source,message,context)
 VALUES('ea100000-0000-4000-8000-000000000002','warning','direct-oversize','oversized actual source',jsonb_build_object('full',repeat('x',300000)));
SELECT pg_temp.direct_assert((SELECT count(*)=1 AND bool_and((octet_length(e.payload::text)<=262144
 AND NOT(e.payload ? 'original_event') AND e.payload->>'evidence_storage'='immutable_reference'
 AND public.fn_read_operational_source_snapshot(e.id)=to_jsonb(f)) IS TRUE)
 FROM operational_alert_events e JOIN financial_alerts f ON e.event_key=f.id::text
 WHERE e.source='financial-alerts-backfill' AND f.id='ea100000-0000-4000-8000-000000000002'),
 'reference hydrates every unchanged byte of the oversized full row');
SAVEPOINT corrupt_reference;
UPDATE operational_alert_events SET payload=jsonb_set(payload,'{evidence_reference,snapshot_md5}','"wrong"')
 WHERE source='financial-alerts-backfill' AND event_key='ea100000-0000-4000-8000-000000000002';
SELECT pg_temp.direct_expect(format('SELECT fn_read_operational_source_snapshot(%s)',id),
 'P0001','reference mismatch') FROM operational_alert_events
 WHERE source='financial-alerts-backfill' AND event_key='ea100000-0000-4000-8000-000000000002';
ROLLBACK TO corrupt_reference;
SAVEPOINT missing_new_task;
UPDATE operational_alert_events SET payload=payload-'target_task_id'
 WHERE source='financial-alerts-backfill' AND event_key='ea100000-0000-4000-8000-000000000002';
SELECT pg_temp.direct_expect(format('SELECT fn_read_operational_source_snapshot(%s)',id),'P0001','task is missing')
 FROM operational_alert_events WHERE source='financial-alerts-backfill' AND event_key='ea100000-0000-4000-8000-000000000002';
ROLLBACK TO missing_new_task;
SAVEPOINT wrong_task;
UPDATE operational_alert_events SET payload=jsonb_set(payload,'{target_task_id}','"00000000-0000-4000-8000-000000000000"')
 WHERE source='financial-alerts-backfill' AND event_key='ea100000-0000-4000-8000-000000000002';
SELECT pg_temp.direct_expect(format('SELECT fn_read_operational_source_snapshot(%s)',id),'P0001','task collision')
 FROM operational_alert_events WHERE source='financial-alerts-backfill' AND event_key='ea100000-0000-4000-8000-000000000002';
ROLLBACK TO wrong_task;

-- An existing wrong original is not overwritten or called a successful capture.
SAVEPOINT original_collision;
SELECT fn_record_operational_alert('financial-alerts-backfill','ea100000-0000-4000-8000-000000000003',
 'direct-collision','firing','warning',jsonb_build_object('target_task_id','01a09b86-5ba8-7290-8657-1041f13dd3ca','original_event',jsonb_build_object(
 'id','ea100000-0000-4000-8000-000000000003','source','direct-collision','resolved',false,'severity','warning','message','earlier conflicting bytes')));
INSERT INTO financial_alerts(id,severity,source,message) VALUES('ea100000-0000-4000-8000-000000000003','warning','direct-collision','actual admitted bytes');
SELECT pg_temp.direct_assert((SELECT count(*)=1 AND bool_and((state='pending' AND last_error LIKE '%original snapshot collision%') IS TRUE)
 FROM operational_source_intake.deliveries d JOIN operational_source_intake.snapshots s USING(snapshot_id)
 WHERE source_id='ea100000-0000-4000-8000-000000000003')
 AND (SELECT payload->'original_event'->>'message'='earlier conflicting bytes' FROM operational_alert_events
 WHERE source='financial-alerts-backfill' AND event_key='ea100000-0000-4000-8000-000000000003'),
 'snapshot collision remains explicit pending and preserves both originals');
ROLLBACK TO original_collision;

-- Storage failure is a different, non-durable boundary. Preserve money/source
-- result and require a diagnostic in this stage's actual stderr (runner below).
SAVEPOINT local_storage_failure;
ALTER TABLE operational_source_intake.snapshots ADD CONSTRAINT direct_test_storage_failure CHECK(source_id<>'ea100000-0000-4000-8000-000000000004') NOT VALID;
INSERT INTO financial_alerts(id,severity,source,message) VALUES('ea100000-0000-4000-8000-000000000004','warning','direct-storage-failure','source survives failed local evidence storage');
SELECT pg_temp.direct_assert(EXISTS(SELECT 1 FROM financial_alerts WHERE id='ea100000-0000-4000-8000-000000000004')
 AND NOT EXISTS(SELECT 1 FROM operational_source_intake.snapshots WHERE source_id='ea100000-0000-4000-8000-000000000004'),
 'local storage failure preserves original source and never fabricates durable pending');
ROLLBACK TO local_storage_failure;
SELECT pg_temp.direct_expect($q$INSERT INTO operational_source_intake.snapshots(source_kind,source_id,snapshot_md5,original_row,first_observed,observation)
 VALUES('financial','ea100000-0000-4000-8000-000000000009',md5('{}'::jsonb::text),'{}',true,'insert')$q$,
 '23514','check constraint');
SELECT pg_temp.direct_expect('DELETE FROM operational_source_intake.snapshots','55000','immutable');
SELECT pg_temp.direct_expect('UPDATE operational_source_intake.snapshots SET original_row=original_row','55000','immutable');
SELECT pg_temp.direct_expect('TRUNCATE operational_source_intake.snapshots CASCADE','55000','immutable');
SELECT pg_temp.direct_assert(NOT has_schema_privilege('anon','operational_source_intake','USAGE')
 AND NOT has_schema_privilege('authenticated','operational_source_intake','USAGE')
 AND NOT has_function_privilege('anon','public.fn_read_operational_source_snapshot(bigint)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.fn_retry_operational_source_snapshot(uuid)','EXECUTE')
 AND NOT has_table_privilege('service_role','operational_source_intake.snapshots','INSERT')
 AND NOT has_table_privilege('service_role','operational_source_intake.deliveries','UPDATE'), 'private access boundary');
SET LOCAL ROLE service_role;
SELECT public.fn_read_operational_source_snapshot(id) IS NOT NULL AS service_hydration FROM operational_alert_events
 WHERE source='financial-alerts-backfill' AND event_key='ea100000-0000-4000-8000-000000000002' \gset
RESET ROLE;
SELECT pg_temp.direct_assert(:'service_hydration'='t','service reads exact admitted reference');
SELECT 'direct-operational-source-intake: rollback-scoped native assertions reached';
ROLLBACK;
