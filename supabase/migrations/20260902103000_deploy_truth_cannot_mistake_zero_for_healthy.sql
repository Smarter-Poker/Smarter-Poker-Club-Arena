-- PHASE 4 OF 6 - DEPLOY TRUTH ZERO-ENGINE CLOSURE.
--
-- The original watcher correctly detected stale lease heartbeats, but only
-- while at least one engine_table_leases row existed. A graceful shutdown
-- calls releaseLeadership() and releaseTables(), deleting every row. If the
-- replacement container then failed to start, v_leases was zero, the stale
-- heartbeat predicate was false, and the watchdog RESOLVED the outage.
--
-- The durable state below distinguishes a normal rolling restart from an
-- engine that stayed absent. It also reads engine_leader, the process-level
-- heartbeat, instead of making table ownership carry the whole liveness
-- contract. The one-minute schedule makes the three-minute grace real while
-- retaining one alert per episode.

CREATE TABLE IF NOT EXISTS public.ca_engine_deploy_watch_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  engine_missing_since timestamptz,
  last_engine_heartbeat timestamptz,
  checked_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ca_engine_deploy_watch_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_engine_deploy_watch_state
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ca_engine_deploy_watch_state
  TO service_role;

COMMENT ON TABLE public.ca_engine_deploy_watch_state IS
  'Singleton debounce state for deploy truth. Zero lease rows become an outage after the rolling-restart grace instead of an all-clear.';


CREATE OR REPLACE FUNCTION public.fn_ca_engine_deploy_truth_watch()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_behind_after     constant interval := interval '8 hours';
  c_silent_after     constant interval := interval '6 hours';
  c_heartbeat_dead   constant interval := interval '180 seconds';
  c_split_brain_live constant interval := interval '60 seconds';

  v_running                 text;
  v_leader_version          text;
  v_table_version           text;
  v_versions_live           int;
  v_leader_rows             int;
  v_leases                  int;
  v_leader_heartbeat        timestamptz;
  v_table_heartbeat         timestamptz;
  v_last_heartbeat          timestamptz;
  v_engine_signal_live      boolean;
  v_engine_missing_since    timestamptz;
  v_target                  text;
  v_target_since            timestamptz;
  v_last_attempt            timestamptz;
  v_ever_reported           boolean;
  v_findings                jsonb := '[]'::jsonb;
BEGIN
  SELECT count(*), max(l.heartbeat_at),
         (array_agg(l.engine_version ORDER BY l.heartbeat_at DESC))[1]
    INTO v_leader_rows, v_leader_heartbeat, v_leader_version
    FROM public.engine_leader l;

  SELECT count(*), max(l.heartbeat_at),
         (array_agg(l.engine_version ORDER BY l.heartbeat_at DESC))[1]
    INTO v_leases, v_table_heartbeat, v_table_version
    FROM public.engine_table_leases l;

  v_last_heartbeat := greatest(v_leader_heartbeat, v_table_heartbeat);
  v_running := coalesce(v_leader_version, v_table_version);
  v_engine_signal_live := v_last_heartbeat IS NOT NULL
                          AND v_last_heartbeat > now() - c_heartbeat_dead;

  -- Persist the first missing observation. A normal rolling restart that
  -- releases its rows and reclaims them inside three minutes never raises.
  -- A stale row uses its own heartbeat as the start, so an already-dead engine
  -- does not get a fresh grace period merely because this migration landed.
  INSERT INTO public.ca_engine_deploy_watch_state (
    singleton, engine_missing_since, last_engine_heartbeat, checked_at
  )
  VALUES (
    true,
    CASE
      WHEN v_engine_signal_live THEN NULL
      WHEN v_last_heartbeat IS NOT NULL THEN v_last_heartbeat
      ELSE now()
    END,
    v_last_heartbeat,
    now()
  )
  ON CONFLICT (singleton) DO UPDATE
     SET engine_missing_since = CASE
           WHEN v_engine_signal_live THEN NULL
           WHEN public.ca_engine_deploy_watch_state.engine_missing_since IS NOT NULL
             THEN public.ca_engine_deploy_watch_state.engine_missing_since
           WHEN v_last_heartbeat IS NOT NULL THEN v_last_heartbeat
           ELSE now()
         END,
         last_engine_heartbeat = coalesce(
           v_last_heartbeat,
           public.ca_engine_deploy_watch_state.last_engine_heartbeat
         ),
         checked_at = now()
  RETURNING engine_missing_since INTO v_engine_missing_since;

  SELECT count(DISTINCT live.engine_version)
    INTO v_versions_live
    FROM (
      SELECT l.engine_version
        FROM public.engine_leader l
       WHERE l.heartbeat_at > now() - c_split_brain_live
      UNION ALL
      SELECT l.engine_version
        FROM public.engine_table_leases l
       WHERE l.heartbeat_at > now() - c_split_brain_live
    ) live;

  SELECT EXISTS (SELECT 1 FROM public.ca_engine_deploy_attempts)
    INTO v_ever_reported;
  SELECT max(at) INTO v_last_attempt FROM public.ca_engine_deploy_attempts;

  SELECT a.target_sha INTO v_target
    FROM public.ca_engine_deploy_attempts a
   ORDER BY a.at DESC
   LIMIT 1;

  IF v_target IS NOT NULL THEN
    SELECT min(a.at) INTO v_target_since
      FROM public.ca_engine_deploy_attempts a
     WHERE a.target_sha = v_target;
  END IF;

  -- 1. No live process heartbeat and no live table heartbeat for the full
  -- grace period. This includes the zero-row state the first version missed.
  IF v_engine_missing_since IS NOT NULL
     AND v_engine_missing_since < now() - c_heartbeat_dead THEN
    v_findings := v_findings || jsonb_build_object(
      'kind', 'engine_heartbeat_stopped',
      'missing_since', v_engine_missing_since,
      'last_heartbeat', v_last_heartbeat,
      'leader_rows', v_leader_rows,
      'leases_held', v_leases);
    IF NOT EXISTS (
      SELECT 1 FROM public.financial_alerts a
       WHERE a.source = 'deploy_truth.engine_heartbeat_stopped' AND NOT a.resolved
    ) THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical',
        'deploy_truth.engine_heartbeat_stopped',
        'No live engine heartbeat has been observed since ' || v_engine_missing_since
          || '. Leader rows: ' || v_leader_rows || '; table leases: ' || v_leases || '.',
        jsonb_build_object(
          'missing_since', v_engine_missing_since,
          'last_heartbeat', v_last_heartbeat,
          'leader_rows', v_leader_rows,
          'leases_held', v_leases,
          'engine_version', v_running
        )
      );
    END IF;
  ELSE
    UPDATE public.financial_alerts
       SET resolved = true, resolved_at = now()
     WHERE source = 'deploy_truth.engine_heartbeat_stopped' AND NOT resolved;
  END IF;

  -- 2. Two build versions are live at once.
  IF v_versions_live > 1 THEN
    v_findings := v_findings || jsonb_build_object(
      'kind', 'engine_split_brain', 'versions', v_versions_live);
    IF NOT EXISTS (
      SELECT 1 FROM public.financial_alerts a
       WHERE a.source = 'deploy_truth.engine_split_brain' AND NOT a.resolved
    ) THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical',
        'deploy_truth.engine_split_brain',
        v_versions_live || ' distinct engine builds are heartbeating at once',
        jsonb_build_object(
          'versions', (
            SELECT jsonb_agg(DISTINCT live.engine_version)
              FROM (
                SELECT l.engine_version
                  FROM public.engine_leader l
                 WHERE l.heartbeat_at > now() - c_split_brain_live
                UNION ALL
                SELECT l.engine_version
                  FROM public.engine_table_leases l
                 WHERE l.heartbeat_at > now() - c_split_brain_live
              ) live
          )
        )
      );
    END IF;
  ELSE
    UPDATE public.financial_alerts
       SET resolved = true, resolved_at = now()
     WHERE source = 'deploy_truth.engine_split_brain' AND NOT resolved;
  END IF;

  -- 3. The shipper itself has gone quiet.
  IF v_ever_reported AND v_last_attempt < now() - c_silent_after THEN
    v_findings := v_findings || jsonb_build_object(
      'kind', 'deploy_pipeline_silent', 'last_attempt', v_last_attempt);
    IF NOT EXISTS (
      SELECT 1 FROM public.financial_alerts a
       WHERE a.source = 'deploy_truth.pipeline_silent' AND NOT a.resolved
    ) THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical',
        'deploy_truth.pipeline_silent',
        'No engine deploy attempt has been recorded since ' || v_last_attempt
          || '. The deploy workflow is not running.',
        jsonb_build_object('last_attempt', v_last_attempt, 'engine_version', v_running)
      );
    END IF;
  ELSE
    UPDATE public.financial_alerts
       SET resolved = true, resolved_at = now()
     WHERE source = 'deploy_truth.pipeline_silent' AND NOT resolved;
  END IF;

  -- 4. The running build differs from the build the pipeline keeps offering.
  IF v_target IS NOT NULL AND v_running IS NOT NULL
     AND left(v_target, 8) <> left(v_running, 8)
     AND v_target_since < now() - c_behind_after THEN
    v_findings := v_findings || jsonb_build_object(
      'kind', 'engine_behind_target',
      'running', v_running,
      'target', left(v_target, 8),
      'since', v_target_since);
    IF NOT EXISTS (
      SELECT 1 FROM public.financial_alerts a
       WHERE a.source = 'deploy_truth.engine_behind_target' AND NOT a.resolved
    ) THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical',
        'deploy_truth.engine_behind_target',
        'The engine is running ' || v_running || ' but the deploy pipeline has been offering '
          || left(v_target, 8) || ' since ' || v_target_since || '. Restart windows have passed.',
        jsonb_build_object(
          'running', v_running,
          'target', left(v_target, 8),
          'target_first_offered', v_target_since
        )
      );
    END IF;
  ELSE
    UPDATE public.financial_alerts
       SET resolved = true, resolved_at = now()
     WHERE source = 'deploy_truth.engine_behind_target' AND NOT resolved;
  END IF;

  RETURN jsonb_build_object(
    'checked_at', now(),
    'engine_version', v_running,
    'leader_rows', v_leader_rows,
    'leases_held', v_leases,
    'last_heartbeat', v_last_heartbeat,
    'engine_missing_since', v_engine_missing_since,
    'last_attempt', v_last_attempt,
    'target_sha', left(coalesce(v_target, ''), 8),
    'findings', v_findings
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_engine_deploy_truth_watch()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_engine_deploy_truth_watch()
  TO service_role;

DO $do$
DECLARE v_jobid bigint;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job
     WHERE jobname IN ('ca-engine-deploy-truth-10m', 'ca-engine-deploy-truth-1m')
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END;
$do$;

SELECT cron.schedule(
  'ca-engine-deploy-truth-1m',
  '* * * * *',
  $job$
  SELECT CASE
           WHEN pg_try_advisory_xact_lock(hashtext('ca-engine-deploy-truth'))
           THEN (SELECT 1 FROM public.fn_ca_engine_deploy_truth_watch())
           ELSE 0
         END;
  $job$
);

COMMENT ON FUNCTION public.fn_ca_engine_deploy_truth_watch() IS
  'Phase 4 deploy truth. Uses leader plus table heartbeats, debounces zero-row engine absence, and raises once per deploy-truth episode.';
