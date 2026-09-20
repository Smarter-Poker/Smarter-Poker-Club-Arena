-- Runs once in the existing fresh core allocation, before the new component.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=public,pg_catalog;
SELECT set_config('direct_intake.execution',:'execution_uuid',true);
DO $admission$
BEGIN
 IF current_user<>'postgres' OR current_database()<>'qual_owner_notify_'||replace(current_setting('direct_intake.execution'),'-','')
   OR inet_server_addr() IS NOT NULL OR EXISTS(SELECT 1 FROM public.engine_alerts)
   OR md5(pg_get_functiondef('public.fn_record_engine_alerts(jsonb)'::regprocedure))<>'2baee523d4b95afa879c230f4a5ff4f0'
 THEN RAISE EXCEPTION 'direct source prepare allocation/preimage differs'; END IF;
END $admission$;
SELECT public.fn_record_engine_alerts(jsonb_build_array(jsonb_build_object('status','firing','labels',
 jsonb_build_object('alertname','DirectSourceLegacy','severity','warning','engine_alert_event_id',:'execution_uuid'::uuid))));
DO $negative$
BEGIN
 IF (SELECT count(*) FROM engine_alerts WHERE alertname='DirectSourceLegacy')<>1
 OR EXISTS(SELECT 1 FROM operational_alert_events WHERE source='engine-alerts-backfill')
 THEN RAISE EXCEPTION 'direct source original gap was not reproduced'; END IF;
END $negative$;
-- Genuine old producer receipts, committed before capture exists. Their exact
-- payloads are read from the canonical receipt table by the two-session cases.
SELECT public.fn_record_engine_alerts(jsonb_agg(jsonb_build_object(
 'status','firing','startsAt','2026-09-17T00:12:34.123456Z','labels',
 jsonb_build_object('alertname','DirectRace'||label,'severity','warning',
 'engine_alert_event_id',extensions.uuid_generate_v5(:'execution_uuid'::uuid,'direct-'||label))) ORDER BY label))
FROM (VALUES('Finite'),('Capture'),('Batch1'),('Batch2'),('Offset')) q(label);
DO $race_preimages$
BEGIN
 IF (SELECT count(*) FROM engine_alerts)<>6 OR (SELECT count(*) FROM engine_alert_delivery_receipts)<>6
 OR EXISTS(SELECT 1 FROM operational_alert_events WHERE source='engine-alerts-backfill')
 THEN RAISE EXCEPTION 'direct source race preimages were not committed without inbox capture'; END IF;
END $race_preimages$;
INSERT INTO public.financial_alerts(id,severity,source,message)
 VALUES(extensions.uuid_generate_v5(:'execution_uuid'::uuid,'direct-financial-race'),'warning','direct-race-financial','original finite-reader row');
COMMIT;
