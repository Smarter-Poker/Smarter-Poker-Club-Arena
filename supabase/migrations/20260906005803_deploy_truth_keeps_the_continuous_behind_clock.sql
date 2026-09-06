-- PHASE 4 OF 6 - RESTORE THE CONTINUOUS ENGINE-BEHIND CLOCK.
--
-- 20260901181455 fixed a hole in deploy truth: measuring from the first
-- attempt for only the newest target SHA lets every newer commit reset the
-- eight-hour alarm. 20260902103000 later replaced the complete watcher while
-- adding zero-engine detection and accidentally restored that vulnerable
-- query.
--
-- Keep the zero-engine repair intact and replace only the target-age block.
-- The clock starts at the first attempt that differs from the running engine
-- after the pipeline last offered the running build. New target SHAs cannot
-- reset it, but a successful catch-up does.

DO $migration$
DECLARE
  v_definition text;
  v_vulnerable text;
  v_continuous text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_ca_engine_deploy_truth_watch';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'fn_ca_engine_deploy_truth_watch not found';
  END IF;

  -- Production received the two earlier changes in merge order rather than
  -- filename order and is already safe. A chronological replay is not. Treat
  -- the semantic guard as authoritative so this migration is idempotent in
  -- both states.
  IF position('left(a.target_sha, 8) <> left(v_running, 8)' IN v_definition) > 0
     AND position('SELECT max(b.at)' IN v_definition) > 0 THEN
    RETURN;
  END IF;

  v_vulnerable := '  IF v_target IS NOT NULL THEN
    SELECT min(a.at) INTO v_target_since
      FROM public.ca_engine_deploy_attempts a
     WHERE a.target_sha = v_target;
  END IF;';

  v_continuous := '  IF v_target IS NOT NULL AND v_running IS NOT NULL THEN
    /* Measure how long this engine has continuously differed from offered
       builds. Keying the clock to the newest SHA lets fresh commits reset it. */
    SELECT min(a.at) INTO v_target_since
      FROM public.ca_engine_deploy_attempts a
     WHERE left(a.target_sha, 8) <> left(v_running, 8)
       AND a.at > coalesce(
             (SELECT max(b.at)
                FROM public.ca_engine_deploy_attempts b
               WHERE left(b.target_sha, 8) = left(v_running, 8)),
             ''-infinity''::timestamptz
           );
  END IF;';

  IF position(v_vulnerable IN v_definition) = 0 THEN
    RAISE EXCEPTION
      'deploy-truth target-age block changed; refusing to rewrite the watcher on a guess';
  END IF;

  EXECUTE replace(v_definition, v_vulnerable, v_continuous);
END
$migration$;

COMMENT ON FUNCTION public.fn_ca_engine_deploy_truth_watch() IS
  'Phase 4 deploy truth. Detects engine absence, split builds, pipeline silence, and continuous lag across changing target SHAs.';
