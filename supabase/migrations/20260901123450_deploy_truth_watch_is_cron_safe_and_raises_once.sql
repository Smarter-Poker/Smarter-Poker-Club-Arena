-- fn_raise_financial_alert demands an authenticated caller; a pg_cron tick has
-- none, so the first version of this function detected every condition and
-- reported none of them. A drill inside a rolled-back transaction is what
-- caught it. fn_raise_server_financial_alert is the systems path.
--
-- And an alarm that re-raises every ten minutes for as long as a condition
-- lasts is a mute button, so each episode now raises once and resolves once.
--
-- 20260901123315 carries this same corrected body, so applying the two in
-- order lands exactly this code.

CREATE OR REPLACE FUNCTION public.fn_ca_engine_deploy_truth_watch()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- Longest legitimate gap between restart windows is 6h (10pm Chicago to 4am
  -- Chicago). Eight hours is that plus a window's worth of grace, so a stale
  -- engine has to miss a whole window before this says anything.
  c_behind_after     constant interval := interval '8 hours';
  -- The workflow's schedule only covers ten hours of the day, so the longest
  -- legitimate silence between scheduled runs is just under five hours.
  c_silent_after     constant interval := interval '6 hours';
  c_heartbeat_dead   constant interval := interval '180 seconds';
  c_split_brain_live constant interval := interval '60 seconds';

  v_running        text;
  v_versions_live  int;
  v_leases         int;
  v_last_heartbeat timestamptz;
  v_target         text;
  v_target_since   timestamptz;
  v_last_attempt   timestamptz;
  v_ever_reported  boolean;
  v_findings       jsonb := '[]'::jsonb;
BEGIN
  SELECT count(*), max(heartbeat_at)
    INTO v_leases, v_last_heartbeat
    FROM public.engine_table_leases;

  -- Only builds that are still heartbeating count as "dealing". A container
  -- that has been replaced leaves its lease rows behind for LEASE_STALE_SECONDS
  -- and must not be mistaken for a second live dealer.
  SELECT count(DISTINCT l.engine_version) INTO v_versions_live
    FROM public.engine_table_leases l
   WHERE l.heartbeat_at > now() - c_split_brain_live;

  SELECT engine_version INTO v_running
    FROM public.engine_table_leases
   ORDER BY heartbeat_at DESC
   LIMIT 1;

  SELECT EXISTS (SELECT 1 FROM public.ca_engine_deploy_attempts) INTO v_ever_reported;
  SELECT max(at) INTO v_last_attempt FROM public.ca_engine_deploy_attempts;

  SELECT a.target_sha INTO v_target
    FROM public.ca_engine_deploy_attempts a
   ORDER BY a.at DESC
   LIMIT 1;

  IF v_target IS NOT NULL THEN
    -- When this target was FIRST attempted, not most recently: the question is
    -- how long the engine has been refusing to move to it.
    SELECT min(a.at) INTO v_target_since
      FROM public.ca_engine_deploy_attempts a
     WHERE a.target_sha = v_target;
  END IF;

  -- 1. The engine is not heartbeating. It holds tables and is not touching them.
  IF v_leases > 0 AND v_last_heartbeat < now() - c_heartbeat_dead THEN
    v_findings := v_findings || jsonb_build_object(
      'kind', 'engine_heartbeat_stopped',
      'last_heartbeat', v_last_heartbeat,
      'leases_held', v_leases);
    IF NOT EXISTS (SELECT 1 FROM public.financial_alerts a
                    WHERE a.source = 'deploy_truth.engine_heartbeat_stopped' AND NOT a.resolved) THEN
    PERFORM public.fn_raise_server_financial_alert('critical', 'deploy_truth.engine_heartbeat_stopped',
      'The engine holds ' || v_leases || ' table lease(s) and has not heartbeat since ' || v_last_heartbeat,
      jsonb_build_object('last_heartbeat', v_last_heartbeat, 'leases_held', v_leases,
                         'engine_version', v_running));
    END IF;
  ELSE
    UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
     WHERE source = 'deploy_truth.engine_heartbeat_stopped' AND NOT resolved;
  END IF;

  -- 2. Two builds are dealing at once. This is the 2026-08-20 split-brain, the
  --    one where two dealers ran one table under a seated human.
  IF v_versions_live > 1 THEN
    v_findings := v_findings || jsonb_build_object('kind', 'engine_split_brain',
      'versions', v_versions_live);
    IF NOT EXISTS (SELECT 1 FROM public.financial_alerts a
                    WHERE a.source = 'deploy_truth.engine_split_brain' AND NOT a.resolved) THEN
    PERFORM public.fn_raise_server_financial_alert('critical', 'deploy_truth.engine_split_brain',
      v_versions_live || ' distinct engine builds are holding table leases at once',
      jsonb_build_object('versions', (SELECT jsonb_agg(DISTINCT l.engine_version)
                                        FROM public.engine_table_leases l
                                       WHERE l.heartbeat_at > now() - c_split_brain_live)));
    END IF;
  ELSE
    UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
     WHERE source = 'deploy_truth.engine_split_brain' AND NOT resolved;
  END IF;

  -- 3. The shipper itself has gone quiet. This is the case a watchdog living
  --    inside GitHub Actions structurally cannot report.
  IF v_ever_reported AND v_last_attempt < now() - c_silent_after THEN
    v_findings := v_findings || jsonb_build_object('kind', 'deploy_pipeline_silent',
      'last_attempt', v_last_attempt);
    IF NOT EXISTS (SELECT 1 FROM public.financial_alerts a
                    WHERE a.source = 'deploy_truth.pipeline_silent' AND NOT a.resolved) THEN
    PERFORM public.fn_raise_server_financial_alert('critical', 'deploy_truth.pipeline_silent',
      'No engine deploy attempt has been recorded since ' || v_last_attempt
        || '. The deploy workflow is not running.',
      jsonb_build_object('last_attempt', v_last_attempt, 'engine_version', v_running));
    END IF;
  ELSE
    UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
     WHERE source = 'deploy_truth.pipeline_silent' AND NOT resolved;
  END IF;

  -- 4. The engine is running something other than what the pipeline has been
  --    trying to give it, and has been for longer than a whole restart window.
  IF v_target IS NOT NULL AND v_running IS NOT NULL
     AND left(v_target, 8) <> left(v_running, 8)
     AND v_target_since < now() - c_behind_after THEN
    v_findings := v_findings || jsonb_build_object('kind', 'engine_behind_target',
      'running', v_running, 'target', left(v_target, 8), 'since', v_target_since);
    IF NOT EXISTS (SELECT 1 FROM public.financial_alerts a
                    WHERE a.source = 'deploy_truth.engine_behind_target' AND NOT a.resolved) THEN
    PERFORM public.fn_raise_server_financial_alert('critical', 'deploy_truth.engine_behind_target',
      'The engine is running ' || v_running || ' but the deploy pipeline has been offering '
        || left(v_target, 8) || ' since ' || v_target_since || '. Restart windows have passed.',
      jsonb_build_object('running', v_running, 'target', left(v_target, 8),
                         'target_first_offered', v_target_since));
    END IF;
  ELSE
    UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
     WHERE source = 'deploy_truth.engine_behind_target' AND NOT resolved;
  END IF;

  RETURN jsonb_build_object(
    'checked_at',     now(),
    'engine_version', v_running,
    'leases_held',    v_leases,
    'last_heartbeat', v_last_heartbeat,
    'last_attempt',   v_last_attempt,
    'target_sha',     left(COALESCE(v_target, ''), 8),
    'findings',       v_findings
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_engine_deploy_truth_watch()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_engine_deploy_truth_watch()
  TO service_role;

