-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831202933; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Zero-drift hygiene (caught by the repo's pre-push definer gate while
-- publishing phase 5): close the remaining anon-reachable SECURITY DEFINER
-- surface on the incident stack. The dashboard RPCs stay callable by
-- logged-in users (they check auth.uid()/management internally); the
-- pre-login roles lose everything; trigger plumbing is not an API.
REVOKE ALL ON FUNCTION public.fn_ca_drift_metrics() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_incident_action(uuid, text, text, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_incident_dashboard(text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_ca_financial_alert_to_incident() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_reconcile_log_to_incident() FROM PUBLIC, anon, authenticated;
