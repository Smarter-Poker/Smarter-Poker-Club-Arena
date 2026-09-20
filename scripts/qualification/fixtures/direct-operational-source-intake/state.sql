-- Whole selected committed row state, not digests or monetary float parsing.
-- Used before/after rollback-scoped cases and retaining component rollback.
BEGIN READ ONLY;
SET LOCAL timezone='UTC';
SET LOCAL statement_timeout='8s';
SELECT jsonb_build_object(
 'financial',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.financial_alerts r),
 'drift',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.ca_drift_incidents r),
 'incident_events',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.ca_incident_events r),
 'incident_recipients',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') FROM public.ca_incident_recipients r),
 'incident_file_failures',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') FROM public.ca_incident_file_failures r),
 'engine',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.engine_alerts r),
 'producer_receipts',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY event_id),'[]') FROM public.engine_alert_delivery_receipts r),
 'inbox',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.operational_alert_events r),
 'snapshots',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY snapshot_id),'[]') FROM operational_source_intake.snapshots r),
 'deliveries',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY snapshot_id),'[]') FROM operational_source_intake.deliveries r));
COMMIT;
