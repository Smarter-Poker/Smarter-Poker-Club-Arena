-- AN ALERT FINDS THE INCIDENT IT MIRRORS WITHOUT A SCAN (2026-09-09)
--
-- `fn_ca_alert_resolution_reaches_the_incident` closes the drift incident that
-- mirrors a financial alert by matching `metadata->>'alert_id'`. That
-- expression was not indexed, so every alert resolution seq-scanned
-- ca_drift_incidents. One row is cheap; resolving a backlog is not - clearing
-- the 2026-09-08 flood timed out inside this trigger at 800 rows.
--
-- The trigger runs on EVERY alert that is ever resolved, so this is not a
-- one-off convenience for a cleanup: it is the index the propagation path has
-- always needed. Partial on the rows the trigger can actually match.
BEGIN;

CREATE INDEX IF NOT EXISTS ca_drift_incidents_alert_id_idx
  ON public.ca_drift_incidents ((metadata->>'alert_id'))
  WHERE metadata ? 'alert_id';

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='ca_drift_incidents_alert_id_idx') THEN
    RAISE EXCEPTION 'the index this migration exists to create is not present';
  END IF;
END $post$;

COMMIT;
