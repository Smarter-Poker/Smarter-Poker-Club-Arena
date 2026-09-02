-- ============================================================================
--  PHASE 1 addendum - the dispatcher must see runs IN FLIGHT, not runs finished
--  ca_engine_deploy_attempts is written when a run ENDS (deploy truth). At :41
--  the only row in "this hour" is the PREVIOUS window's run finishing at :00,
--  so fn_ca_deploy_run_exists_this_hour said "exists" for the wrong run
--  (observed live 2026-09-02 20:41:00, action=skipped_existing_run). The
--  workflow now records that it STARTED, and the dispatcher reads that.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_engine_deploy_runs_started (
  run_id      TEXT PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_sha  TEXT NOT NULL,
  actor       TEXT
);
COMMENT ON TABLE public.ca_engine_deploy_runs_started IS
  'One row per auto-deploy-hetzner run, written by the workflow the moment it starts (before tests). The DB-side dispatcher at :41 asks this table whether a run for the coming :55 window is already in flight.';
ALTER TABLE public.ca_engine_deploy_runs_started ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_ca_engine_deploy_runs_started_at ON public.ca_engine_deploy_runs_started (started_at DESC);

CREATE OR REPLACE FUNCTION public.fn_ca_record_engine_deploy_start(p_run_id TEXT, p_target_sha TEXT, p_actor TEXT DEFAULT NULL)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v TIMESTAMPTZ;
BEGIN
  INSERT INTO public.ca_engine_deploy_runs_started (run_id, target_sha, actor)
  VALUES (p_run_id, p_target_sha, p_actor)
  ON CONFLICT (run_id) DO UPDATE SET target_sha = EXCLUDED.target_sha
  RETURNING started_at INTO v;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_record_engine_deploy_start(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_engine_deploy_start(TEXT, TEXT, TEXT) TO service_role;

-- A run "exists for the coming window" when one STARTED in the last 25 minutes:
-- dispatched at :41 covers :55; anything started before :16 belongs to the last
-- window and has already finished or given up.
CREATE OR REPLACE FUNCTION public.fn_ca_deploy_run_exists_this_hour()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.ca_engine_deploy_runs_started
                  WHERE started_at >= now() - interval '25 minutes');
$$;

-- Keep the marker table small: 14 days is plenty of history.
CREATE OR REPLACE FUNCTION public.fn_ca_prune_deploy_run_markers()
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  WITH d AS (DELETE FROM public.ca_engine_deploy_runs_started WHERE started_at < now() - interval '14 days' RETURNING 1)
  SELECT count(*)::int FROM d;
$$;
REVOKE ALL ON FUNCTION public.fn_ca_prune_deploy_run_markers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_prune_deploy_run_markers() TO service_role;

COMMIT;
