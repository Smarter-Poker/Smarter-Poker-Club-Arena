-- THE CASCADE INDEX MATCHES THE CAST THE TRIGGER MAKES (2026-09-09)
--
-- The companion migration indexed `financial_alerts ((context->>'incident_id'))`
-- as TEXT, and the cascade stayed slow, because the trigger compares
--
--     (f.context->>'incident_id')::uuid = NEW.id
--
-- A text index cannot serve a uuid comparison, so the planner ignored it and
-- kept seq-scanning 18,226 rows per closed incident. An index is only an index
-- if its expression is the one the query actually writes.
--
-- This indexes the cast, under the same regex predicate the trigger applies,
-- so the partial index is usable and the cast can never fail during the build.
-- Verified before creating: all 4,811 rows matching that regex are canonical
-- lowercase uuids, 0 exceptions.
BEGIN;

CREATE INDEX IF NOT EXISTS financial_alerts_incident_uuid_idx
  ON public.financial_alerts (((context->>'incident_id')::uuid))
  WHERE context->>'incident_id' ~ '^[0-9a-fA-F-]{36}$';

-- Same defect on the other leg of the cascade: alert -> incident also casts.
CREATE INDEX IF NOT EXISTS ca_drift_incidents_alert_uuid_idx
  ON public.ca_drift_incidents (((metadata->>'alert_id')::uuid))
  WHERE metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$';

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                  AND indexname='financial_alerts_incident_uuid_idx') THEN
    RAISE EXCEPTION 'financial_alerts_incident_uuid_idx was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                  AND indexname='ca_drift_incidents_alert_uuid_idx') THEN
    RAISE EXCEPTION 'ca_drift_incidents_alert_uuid_idx was not created';
  END IF;
END $post$;

COMMIT;
