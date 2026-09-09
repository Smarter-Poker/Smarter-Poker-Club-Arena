-- THE INCIDENT/ALERT CASCADE RUNS ON INDEXES BOTH WAYS (2026-09-09)
--
-- Resolution propagates in BOTH directions, and neither side was indexed:
--
--   fn_ca_alert_resolution_reaches_the_incident   alert -> incident
--       matches ca_drift_incidents.metadata->>'alert_id'
--   fn_ca_incident_resolution_reaches_the_alerts  incident -> alert
--       matches financial_alerts.context->>'incident_id'
--
-- So resolving ONE alert seq-scanned 5,709 incidents, closed an incident, and
-- that closure then seq-scanned 18,226 alerts. Resolving a backlog is
-- quadratic and times out - it did, twice, at batches of 800 and 400.
--
-- 4,811 of the 18,226 alert rows carry an incident_id, so the index is partial
-- on exactly the rows this trigger can match.
BEGIN;

CREATE INDEX IF NOT EXISTS financial_alerts_incident_id_idx
  ON public.financial_alerts ((context->>'incident_id'))
  WHERE context ? 'incident_id';

-- The trigger's other predicate is `NOT resolved`; an unresolved-only partial
-- index keeps the cascade cheap as the table grows, since resolved rows are
-- never revisited by it.
CREATE INDEX IF NOT EXISTS financial_alerts_unresolved_source_idx
  ON public.financial_alerts (source)
  WHERE NOT resolved;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                  AND indexname='financial_alerts_incident_id_idx') THEN
    RAISE EXCEPTION 'the incident_id index this migration exists to create is not present';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                  AND indexname='financial_alerts_unresolved_source_idx') THEN
    RAISE EXCEPTION 'the unresolved-source index is not present';
  END IF;
END $post$;

COMMIT;
