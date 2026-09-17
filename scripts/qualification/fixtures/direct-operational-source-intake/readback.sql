-- Independent read-only observer after case rollback and retaining rollback.
BEGIN READ ONLY;
SET LOCAL timezone='UTC';
SET LOCAL statement_timeout='8s';
DO $observe$
BEGIN
 IF (SELECT count(*) FROM operational_source_intake.snapshots)<>4
 OR (SELECT count(*) FROM operational_source_intake.deliveries)<>4
 OR (SELECT count(*) FROM operational_source_intake.deliveries WHERE state='pending' AND inbox_event_id IS NULL
   AND last_error='P0001:operational source exact receipt collision')<>1
 OR (SELECT count(*) FROM operational_source_intake.deliveries WHERE state='captured')<>3
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='a00_operational_source_intake' AND NOT tgisinternal)
 OR to_regprocedure('public.fn_retry_operational_source_snapshot(uuid)') IS NOT NULL
 OR to_regprocedure('public.fn_capture_operational_source_event()') IS NOT NULL
 OR to_regprocedure('public.fn_read_operational_source_snapshot(bigint)') IS NULL
 OR md5(pg_get_functiondef('public.fn_record_engine_alerts(jsonb)'::regprocedure))<>'2baee523d4b95afa879c230f4a5ff4f0'
 OR (SELECT count(*) FROM engine_alerts)<>7
 OR (SELECT count(*) FROM engine_alert_delivery_receipts)<>7
 OR (SELECT count(*) FROM financial_alerts)<>2
 OR (SELECT count(*) FROM operational_alert_events)<>11
 OR (SELECT count(*) FROM operational_alert_events e JOIN operational_source_intake.deliveries d ON d.inbox_event_id=e.id
   JOIN operational_source_intake.snapshots s USING(snapshot_id)
   WHERE e.payload->>'evidence_storage'='immutable_reference'
   AND public.fn_read_operational_source_snapshot(e.id)=s.original_row)<>2
 OR EXISTS(SELECT 1 FROM operational_alert_events e
   WHERE e.source IN ('financial-alerts-backfill','financial-alerts-updates','engine-alerts-backfill','engine-alerts-updates')
   AND public.fn_read_operational_source_snapshot(e.id) IS NULL)
 THEN RAISE EXCEPTION 'direct source original state/retaining rollback differs'; END IF;
END $observe$;
COMMIT;
