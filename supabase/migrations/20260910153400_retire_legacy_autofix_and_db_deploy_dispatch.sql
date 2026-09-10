-- Retire the legacy automatic mutation paths after their source
-- implementations were removed. Historical rows are preserved in a locked
-- archive schema; no runtime role can call or read these retired surfaces.
--
-- ca_engine_deploy_attempts and fn_ca_record_engine_deploy_attempt are not a
-- watcher or dispatcher. They are the append-only release receipt written by
-- the deployment itself, so they deliberately remain active and private.

BEGIN;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid
    FROM cron.job
    WHERE jobname IN (
            'ca-deploy-dispatch',
            'ca-deploy-run-marker-prune',
            'ca-engine-deploy-truth-10m',
            'ca-engine-deploy-truth-1m'
          )
       OR lower(command) ~
          '(fn_ca_deploy_dispatch_tick|fn_ca_deploy_run_exists_this_hour|fn_ca_record_engine_deploy_start|fn_ca_prune_deploy_run_markers|fn_ca_engine_deploy_truth_watch)'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;
END
$$;

DROP VIEW IF EXISTS public.autofix_attempts_summary;

DO $$
BEGIN
  IF to_regclass('public.autofix_attempts') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS autofix_attempts_touch ON public.autofix_attempts;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.autofix_attempts_touch_updated_at();
DROP FUNCTION IF EXISTS public.autofix_budget_exhausted(numeric);
DROP FUNCTION IF EXISTS public.autofix_budget_exhausted(text);
DROP FUNCTION IF EXISTS public.autofix_daily_spend_usd(date);
DROP FUNCTION IF EXISTS public.autofix_is_paused();

-- Drop every overload of the retired functions. This closes the legacy path
-- even if an environment contains an older signature than the final source
-- migration did.
DO $$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT n.nspname AS schema_name,
           p.proname AS function_name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'fn_ca_deploy_dispatch_tick',
         'fn_ca_deploy_run_exists_this_hour',
         'fn_ca_record_engine_deploy_start',
         'fn_ca_prune_deploy_run_markers',
         'fn_ca_engine_deploy_truth_watch'
       )
  LOOP
    EXECUTE format(
      'DROP FUNCTION %I.%I(%s)',
      v_function.schema_name,
      v_function.function_name,
      v_function.identity_arguments
    );
  END LOOP;
END
$$;

-- This secret existed solely so the retired database dispatcher could call
-- GitHub. Delete the named secret without selecting or logging its value.
DO $$
BEGIN
  IF to_regclass('vault.secrets') IS NOT NULL THEN
    EXECUTE 'DELETE FROM vault.secrets WHERE name = $1'
      USING 'ca_deploy_dispatch_token';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS ca_archive;
COMMENT ON SCHEMA ca_archive IS
  'Locked historical records for retired Club Arena automation. No runtime access.';

DO $$
BEGIN
  IF to_regclass('public.autofix_attempts') IS NOT NULL THEN
    ALTER TABLE public.autofix_attempts SET SCHEMA ca_archive;
  END IF;
  IF to_regclass('public.autofix_budget') IS NOT NULL THEN
    ALTER TABLE public.autofix_budget SET SCHEMA ca_archive;
  END IF;
  IF to_regclass('public.autofix_config') IS NOT NULL THEN
    ALTER TABLE public.autofix_config SET SCHEMA ca_archive;
  END IF;
  IF to_regclass('public.autofix_projects') IS NOT NULL THEN
    ALTER TABLE public.autofix_projects SET SCHEMA ca_archive;
  END IF;
  IF to_regclass('public.ca_deploy_dispatch_config') IS NOT NULL THEN
    ALTER TABLE public.ca_deploy_dispatch_config SET SCHEMA ca_archive;
  END IF;
  IF to_regclass('public.ca_deploy_dispatch_log') IS NOT NULL THEN
    ALTER TABLE public.ca_deploy_dispatch_log SET SCHEMA ca_archive;
  END IF;
  IF to_regclass('public.ca_engine_deploy_runs_started') IS NOT NULL THEN
    ALTER TABLE public.ca_engine_deploy_runs_started SET SCHEMA ca_archive;
  END IF;
  IF to_regclass('public.ca_engine_deploy_watch_state') IS NOT NULL THEN
    ALTER TABLE public.ca_engine_deploy_watch_state SET SCHEMA ca_archive;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA ca_archive FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA ca_archive FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ca_archive FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.ca_engine_deploy_attempts IS
  'Append-only audit receipts written by Club Arena engine release runs; not a dispatcher or polling watcher.';
COMMENT ON FUNCTION public.fn_ca_record_engine_deploy_attempt(text, boolean, text, text, text) IS
  'Records one append-only Club Arena engine release receipt for audit and incident review.';

-- Fail closed if any executable legacy route survived retirement. These
-- assertions intentionally abort the migration instead of leaving a partial
-- cleanup that appears successful.
DO $$
DECLARE
  v_remaining text;
  v_secret_count bigint := 0;
BEGIN
  SELECT string_agg(format('%s: %s', jobname, command), E'\n' ORDER BY jobid)
    INTO v_remaining
    FROM cron.job
   WHERE jobname IN (
           'ca-deploy-dispatch',
           'ca-deploy-run-marker-prune',
           'ca-engine-deploy-truth-10m',
           'ca-engine-deploy-truth-1m'
         )
      OR lower(command) ~
         '(fn_ca_deploy_dispatch_tick|fn_ca_deploy_run_exists_this_hour|fn_ca_record_engine_deploy_start|fn_ca_prune_deploy_run_markers|fn_ca_engine_deploy_truth_watch)';

  IF v_remaining IS NOT NULL THEN
    RAISE EXCEPTION 'retired Club Arena deployment cron paths remain: %', v_remaining;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_remaining
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'fn_ca_deploy_dispatch_tick',
       'fn_ca_deploy_run_exists_this_hour',
       'fn_ca_record_engine_deploy_start',
       'fn_ca_prune_deploy_run_markers',
       'fn_ca_engine_deploy_truth_watch'
     );

  IF v_remaining IS NOT NULL THEN
    RAISE EXCEPTION 'retired Club Arena deployment functions remain: %', v_remaining;
  END IF;

  IF to_regclass('vault.secrets') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM vault.secrets WHERE name = $1'
      INTO v_secret_count
      USING 'ca_deploy_dispatch_token';
  END IF;

  IF v_secret_count <> 0 THEN
    RAISE EXCEPTION 'retired Club Arena deployment dispatcher secret remains';
  END IF;

  IF to_regclass('public.ca_engine_deploy_attempts') IS NULL
     OR to_regprocedure(
       'public.fn_ca_record_engine_deploy_attempt(text,boolean,text,text,text)'
     ) IS NULL THEN
    RAISE EXCEPTION 'append-only Club Arena deployment receipt was removed';
  END IF;

  IF to_regclass('public.ca_engine_deploy_watch_state') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy Club Arena deployment watcher state remains public';
  END IF;
END
$$;

COMMIT;
