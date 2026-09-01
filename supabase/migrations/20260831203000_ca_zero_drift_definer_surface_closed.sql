-- Zero-drift hygiene (prod 2026-08-31 20:2x UTC, caught by the pre-push
-- definer gate): close the remaining anon-reachable SECURITY DEFINER surface
-- on the incident stack. Dashboard RPCs stay callable by logged-in users
-- (they check auth internally); pre-login roles lose everything; trigger
-- plumbing is not an API.
REVOKE ALL ON FUNCTION public.fn_ca_drift_metrics() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_incident_action(uuid, text, text, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_incident_dashboard(text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_financial_alert_to_incident() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_reconcile_log_to_incident() FROM PUBLIC, anon, authenticated;
