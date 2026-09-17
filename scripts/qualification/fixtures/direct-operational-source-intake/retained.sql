-- Commit only disposable source evidence. No payment or production identity.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL timezone='UTC';
SET LOCAL search_path=public,pg_temp;
CREATE FUNCTION pg_temp.retained_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'direct retained evidence: %',label; END IF; END $$;
SELECT pg_temp.retained_assert(current_user='postgres' AND session_user='postgres'
 AND current_database()='qual_owner_notify_'||replace(:'execution_uuid','-','')
 AND inet_server_addr() IS NULL, 'exact disposable allocation');
CREATE TEMP TABLE offset_current AS SELECT to_jsonb(a) full_row,r.payload FROM engine_alerts a
 JOIN engine_alert_delivery_receipts r ON r.engine_alert_id=a.id WHERE alertname='DirectRaceOffset';
SELECT pg_temp.retained_assert((SELECT count(*)=1 FROM offset_current),'exact old offset case');
SET LOCAL timezone='America/Chicago';
SELECT fn_record_operational_alert('engine-alerts-backfill',id::text,alertname,status,severity,
 jsonb_build_object('original_event',to_jsonb(a),'captured_at',clock_timestamp(),
 'backfill_window_start','2026-09-01T00:00:00Z')) FROM engine_alerts a WHERE alertname='DirectRaceOffset';
CREATE TEMP TABLE offset_original AS SELECT to_jsonb(e) full_row FROM operational_alert_events e
 WHERE source='engine-alerts-backfill' AND alertname='DirectRaceOffset';
SET LOCAL timezone='UTC';
SELECT pg_temp.retained_assert((SELECT (o.full_row->'payload'->'original_event') IS DISTINCT FROM c.full_row
 AND ((o.full_row->'payload'->'original_event'->>'starts_at')::timestamptz=(c.full_row->>'starts_at')::timestamptz)
 AND ((o.full_row->'payload'->'original_event'->>'received_at')::timestamptz=(c.full_row->>'received_at')::timestamptz)
 AND ((o.full_row->'payload'->'original_event')-'starts_at'-'received_at')=(c.full_row-'starts_at'-'received_at')
 FROM offset_original o CROSS JOIN offset_current c), 'different retained JSON offsets, same instants and other fields');
SELECT fn_record_engine_alerts(jsonb_build_array(payload)) FROM offset_current;
SELECT pg_temp.retained_assert((SELECT count(*)=1 AND bool_and((e.payload->'original_event'=c.full_row
 AND e.payload->>'snapshot_kind'='replay' AND e.payload->>'original_inbox_id'=o.full_row->>'id'
 AND e.event_key=(c.full_row->>'id')||':'||md5(c.full_row::text)) IS TRUE)
 FROM operational_alert_events e CROSS JOIN offset_current c CROSS JOIN offset_original o
 WHERE e.source='engine-alerts-updates' AND e.alertname='DirectRaceOffset'),
 'UTC observation is a distinct linked snapshot, not normalized old evidence');
SELECT pg_temp.retained_assert((SELECT e.payload=o.full_row->'payload' FROM operational_alert_events e
 CROSS JOIN offset_original o WHERE e.id=(o.full_row->>'id')::bigint), 'retained offset payload unchanged');
CREATE TEMP TABLE offset_after AS SELECT to_jsonb(e) full_row FROM operational_alert_events e WHERE alertname='DirectRaceOffset';
SELECT fn_record_engine_alerts(jsonb_build_array(payload)) FROM offset_current;
SELECT pg_temp.retained_assert((SELECT jsonb_agg(full_row ORDER BY full_row->>'id') FROM offset_after)=
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id::text) FROM operational_alert_events e WHERE alertname='DirectRaceOffset'),
 'repeated UTC replay preserves both complete retained snapshots');

INSERT INTO financial_alerts(id,severity,source,message,context)
 VALUES(extensions.uuid_generate_v5(:'execution_uuid'::uuid,'direct-retained-large'),'warning','direct-retained-large',
 'committed full evidence survives component rollback',jsonb_build_object('full',repeat('x',300000)));
CREATE TEMP TABLE retained_engine_payload AS SELECT jsonb_build_array(jsonb_build_object('status','firing','labels',
 jsonb_build_object('alertname','DirectRetainedLargeEngine','severity','warning','component',repeat('x',140000),
 'engine_alert_event_id',extensions.uuid_generate_v5(:'execution_uuid'::uuid,'direct-retained-engine')))) payload;
SELECT pg_temp.retained_assert((SELECT pg_column_size(payload)<=262144 FROM retained_engine_payload),
 'committed large row uses a valid unchanged producer request');
SELECT fn_record_engine_alerts(payload) FROM retained_engine_payload;
SELECT pg_temp.retained_assert((SELECT count(*)=4 AND count(*) FILTER(WHERE d.state='pending')=1
 AND count(*) FILTER(WHERE d.state='captured')=3 FROM operational_source_intake.snapshots s
 JOIN operational_source_intake.deliveries d USING(snapshot_id)), 'nonempty pending and captured evidence commits');
SELECT pg_temp.retained_assert((SELECT count(*)=2 AND bool_and((e.payload->>'evidence_storage'='immutable_reference'
 AND NOT(e.payload ? 'original_event') AND fn_read_operational_source_snapshot(e.id)=s.original_row
 AND octet_length(s.original_row::text)>262144 AND octet_length(e.payload::text)<=262144) IS TRUE)
 FROM operational_source_intake.snapshots s JOIN operational_source_intake.deliveries d USING(snapshot_id)
 JOIN operational_alert_events e ON e.id=d.inbox_event_id
 WHERE e.alertname IN ('direct-retained-large','DirectRetainedLargeEngine')), 'both whole large references before rollback');
COMMIT;
