-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417060152 "create_deploy_alerts_table"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 05bcff38853fd6cc7478c022b96e7617 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Deploy-monitor alert dedup table — prevents duplicate GitHub issues / emails
-- when the same underlying condition fires multiple times (e.g. 5 failed deploys in a row).
-- Used by pages/api/deploy-monitor.js (isRecentlyAlerted / recordAlert helpers).
CREATE TABLE IF NOT EXISTS public.deploy_alerts (
  alert_key   TEXT PRIMARY KEY,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the common query: "is this key still within its cooldown window?"
CREATE INDEX IF NOT EXISTS idx_deploy_alerts_expires_at
  ON public.deploy_alerts (expires_at);

-- Row-level security: only the service_role can read/write (this is an ops table,
-- never accessed by end-users).
ALTER TABLE public.deploy_alerts ENABLE ROW LEVEL SECURITY;

-- Cleanup: delete rows whose cooldown has expired. Runs on every write via trigger.
CREATE OR REPLACE FUNCTION public.cleanup_expired_deploy_alerts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.deploy_alerts WHERE expires_at < now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_expired_deploy_alerts ON public.deploy_alerts;
CREATE TRIGGER trg_cleanup_expired_deploy_alerts
  AFTER INSERT ON public.deploy_alerts
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.cleanup_expired_deploy_alerts();

COMMENT ON TABLE public.deploy_alerts IS
  'Ops table: alert dedup for deploy-monitor. Auto-cleans expired rows on each insert.';
