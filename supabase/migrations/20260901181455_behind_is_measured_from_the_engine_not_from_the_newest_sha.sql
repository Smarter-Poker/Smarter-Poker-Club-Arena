-- fn_ca_engine_deploy_truth_watch measured "how long has the engine been
-- behind" as "how old is the newest sha the pipeline has offered". Those are
-- not the same thing, and the difference is a hole you can drive a stale
-- engine through: every new commit resets the clock, so a pipeline that keeps
-- offering fresh shas every couple of hours can never accumulate the eight
-- hours the alarm needs, no matter how long the engine refuses to move.
--
-- Seen live on 2026-09-01, the day the watchdog shipped. The engine sat on
-- bda90d71 from 04:11 UTC. Between 14:58 and 16:00 the pipeline offered
-- f5859e14, then 12899f11 twice, then 240ce7b5 - four attempts, three shas,
-- none landing, because the financial health-gate was refusing to deploy onto
-- what it read as a bleeding ledger. The alarm stayed silent for all of it,
-- and by its own rule it was right: the newest sha was two hours old.
--
-- So measure it from the ENGINE. The clock starts at the first attempt that
-- offered something OTHER than what the engine is running, counting only
-- attempts since the pipeline last offered the running build. That is exactly
-- "how long has this engine been refusing the thing it is being given", and no
-- number of new commits can reset it.
--
-- Surgical on purpose: it replaces ONE query inside the function and leaves
-- every other check alone, including the leader-row and engine-missing work
-- another agent added the same afternoon. It raises rather than rewriting the
-- function on a guess if the text it expects has moved.
--
-- Drilled inside a rolled-back transaction before it was trusted: three
-- different shas across twenty hours, none of them the running build, now
-- report `since` twenty hours ago and raise the critical. The old logic read
-- the same rows as twenty MINUTES and said nothing.
DO $mig$
DECLARE
  v_def  text;
  v_old  text;
  v_new  text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_engine_deploy_truth_watch';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_ca_engine_deploy_truth_watch not found';
  END IF;

  v_old := '  IF v_target IS NOT NULL THEN
    SELECT min(a.at) INTO v_target_since
      FROM public.ca_engine_deploy_attempts a
     WHERE a.target_sha = v_target;
  END IF;';

  v_new := '  IF v_target IS NOT NULL AND v_running IS NOT NULL THEN
    /* How long has the ENGINE been behind - not how old is the newest sha.
       Keyed on the newest sha, every fresh commit reset the clock and a
       permanently stuck engine could never age past the threshold. */
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

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION
      'the target-age block is not where this migration expected it; refusing to rewrite the function on a guess';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;
