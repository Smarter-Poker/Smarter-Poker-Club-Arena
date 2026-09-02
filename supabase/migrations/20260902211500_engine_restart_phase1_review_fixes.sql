-- ============================================================================
--  PHASE 1 review fixes (three defects found reviewing my own work)
-- ============================================================================
BEGIN;

-- (2) The pre mark waits for the freeze to actually engage. pg_cron fires at
-- :55:00-:55:01; the engine flips the freeze at ~:55:04. Wait up to 25s.
CREATE OR REPLACE FUNCTION public.fn_ca_capture_freeze_mark(p_kind TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_win TIMESTAMPTZ; m NUMERIC; f NUMERIC; t NUMERIC; i INTEGER := 0;
BEGIN
  IF p_kind NOT IN ('pre','post') THEN
    RAISE EXCEPTION 'p_kind must be pre or post, got %', p_kind;
  END IF;
  v_win := CASE WHEN p_kind = 'pre'
                THEN date_trunc('hour', now()) + interval '1 hour'
                ELSE date_trunc('hour', now() + interval '2 minutes') END;
  -- A pre mark taken before the freeze engages measures three seconds of live
  -- play, not the freeze. Wait for the platform to actually be frozen.
  IF p_kind = 'pre' THEN
    WHILE NOT public.fn_platform_frozen() AND i < 25 LOOP
      PERFORM pg_sleep(1); i := i + 1;
    END LOOP;
  END IF;
  SELECT member_wallets, on_the_felt, total INTO m, f, t FROM public.fn_ca_circulation_total();
  INSERT INTO public.ca_freeze_circulation_marks (window_hour, kind, member_wallets, on_the_felt, total)
  VALUES (v_win, p_kind, m, f, t)
  ON CONFLICT (window_hour, kind) DO UPDATE
     SET member_wallets = EXCLUDED.member_wallets,
         on_the_felt    = EXCLUDED.on_the_felt,
         total          = EXCLUDED.total,
         mark_at        = now();
  RETURN v_win;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_capture_freeze_mark(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_capture_freeze_mark(TEXT) TO service_role;

-- (3) The dispatcher refuses to fire until the workflow's start-marker writer
-- has proven itself by writing at least once. Armed before that, it would
-- fire on top of GitHub's own cron every hour.
CREATE OR REPLACE FUNCTION public.fn_ca_deploy_dispatch_tick(p_dry_run BOOLEAN DEFAULT TRUE)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp', 'vault'
AS $$
DECLARE
  cfg public.ca_deploy_dispatch_config;
  v_win TIMESTAMPTZ := date_trunc('hour', now()) + interval '1 hour';
  v_token text; v_url text; v_action text; v_req bigint;
BEGIN
  SELECT * INTO cfg FROM public.ca_deploy_dispatch_config WHERE id;

  IF public.fn_ca_deploy_run_exists_this_hour() THEN
    v_action := 'skipped_existing_run';
  ELSIF NOT cfg.enabled THEN
    v_action := 'disarmed';
  ELSIF NOT EXISTS (SELECT 1 FROM public.ca_engine_deploy_runs_started) THEN
    -- The only way this dispatcher knows a run is in flight is the marker the
    -- workflow writes at start. Until one has ever been written, that step is
    -- not live and firing would duplicate GitHub's cron every hour.
    v_action := 'no_marker_writer_yet';
  ELSE
    SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = cfg.vault_secret;
    IF v_token IS NULL OR v_token = '' THEN
      v_action := 'no_token';
    ELSIF p_dry_run THEN
      v_action := 'dry_run';
    ELSE
      v_url := 'https://api.github.com/repos/' || cfg.repo
             || '/actions/workflows/' || cfg.workflow_file || '/dispatches';
      SELECT net.http_post(
        url := v_url,
        body := jsonb_build_object('ref', cfg.ref, 'inputs', '{}'::jsonb),
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_token,
          'Accept', 'application/vnd.github+json',
          'User-Agent', 'ca-db-dispatcher',
          'Content-Type', 'application/json')
      ) INTO v_req;
      v_action := 'dispatched';
    END IF;
  END IF;

  INSERT INTO public.ca_deploy_dispatch_log (window_hour, action, net_request_id, detail)
  VALUES (v_win, v_action, v_req,
          jsonb_build_object('enabled', cfg.enabled, 'dry_run', p_dry_run));
  RETURN jsonb_build_object('window_hour', v_win, 'action', v_action, 'net_request_id', v_req);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_deploy_dispatch_tick(BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_deploy_dispatch_tick(BOOLEAN) TO service_role;

COMMIT;

-- ── The crons, idempotently (unschedule-if-present, then schedule) ──────────
-- Phase 1's first migrations created these by hand; a rebuild from files
-- would have lost them. Recorded here once. (1) the scorecard moves :06 -> :12
-- so its ten-minute recovery scan is not scoring minutes that have not
-- happened yet.
BEGIN;
DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT * FROM (VALUES
      ('ca-freeze-mark-pre',         '55 * * * *', $c$SELECT public.fn_ca_capture_freeze_mark('pre')$c$),
      ('ca-freeze-mark-post',        '0 * * * *',  $c$SELECT public.fn_ca_capture_freeze_mark('post')$c$),
      ('ca-break-scorecard',         '12 * * * *', $c$SELECT public.fn_ca_record_break_scorecard()$c$),
      ('ca-deploy-dispatch',         '41 * * * *', $c$SELECT public.fn_ca_deploy_dispatch_tick(false)$c$),
      ('ca-deploy-run-marker-prune', '23 4 * * *', $c$SELECT public.fn_ca_prune_deploy_run_markers()$c$)
    ) AS t(jobname, schedule, command)
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j.jobname) THEN
      PERFORM cron.unschedule(j.jobname);
    END IF;
    PERFORM cron.schedule(j.jobname, j.schedule, j.command);
  END LOOP;
END $$;
COMMIT;
