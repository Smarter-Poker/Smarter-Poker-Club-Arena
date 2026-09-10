-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831094246; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ─────────────────────────────────────────────────────────────────────────────
-- SILENCE IS THE SIGNAL (2026-08-31)
--
-- On 2026-08-31 the production CRON_SECRET was rotated and the Hetzner VM was
-- never updated. Every Open Claw job began returning 401. Eighty-five jobs -
-- push notifications, every anti-cheat and collusion scan, chip-supply
-- snapshots - stopped, and NOTHING anywhere noticed. It was found by hand,
-- reading the VM's journal.
--
-- WHY THE EXISTING GUARD COULD NOT SEE IT. check-cron-liveness.mjs asks
-- "runs >= 3 AND successes == 0" over seven days, in CI. Two reasons that
-- misses this entirely:
--
--   1. A 401 NEVER REACHES THE LOGGING LAYER. validateCronAuth rejects before
--      withCronHealth records anything, so there is no failed row to count -
--      the log simply STOPS. The newest cron_execution_log row today is
--      08:59:00, the exact minute the 401s began.
--   2. Even if it were logged, a seven-day window full of last week's
--      successes cannot fail on today's outage, and CI only runs on a pull
--      request. An outage between PRs is invisible for as long as nobody opens
--      one.
--
-- So the detectable fact is not a failure. It is SILENCE. This function
-- measures it.
--
-- THE THRESHOLD IS MEASURED, NOT GUESSED. Over the seven days before this was
-- written: 21,095 rows, p99 gap 1 minute, p99.9 gap 4 minutes, and the single
-- worst gap 11.0 minutes. The live outage was already 43 minutes when this was
-- applied. 25 minutes is therefore more than twice the worst gap ever observed
-- in a normal week, which makes a false alarm unlikely and still catches a
-- dead fleet inside half an hour instead of never.
--
-- WHO CALLS IT: Club Arena's read-only production integrity audit, outside the
-- cron fleet's failure domain. It reports but never retries or mutates runtime.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.fn_cron_fleet_silence(int);
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_cron_fleet_silence(
  p_threshold_minutes int DEFAULT 25
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_newest    timestamptz;
  v_silence   numeric;
  v_last_hour int;
  v_stale     jsonb;
BEGIN
  SELECT max(started_at) INTO v_newest FROM public.cron_execution_log;

  -- An empty log is not "healthy quiet"; it is the same outage with no
  -- history to compare against. Report it as maximally silent rather than
  -- letting a NULL read as fine.
  IF v_newest IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'cron_execution_log is empty',
      'silence_minutes', NULL,
      'threshold_minutes', p_threshold_minutes
    );
  END IF;

  v_silence := round(EXTRACT(epoch FROM (now() - v_newest)) / 60.0, 1);

  SELECT count(*) INTO v_last_hour
    FROM public.cron_execution_log
   WHERE started_at > now() - interval '1 hour';

  -- Which jobs have gone quiet longest, for the issue body. Restricted to jobs
  -- seen in the last 7 days so a retired job cannot haunt the report forever.
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'quiet_minutes' DESC), '[]'::jsonb)
    INTO v_stale
    FROM (
      SELECT jsonb_build_object(
               'job', job_name,
               'quiet_minutes', round(EXTRACT(epoch FROM (now() - max(started_at)))/60.0, 1)
             ) AS x
        FROM public.cron_execution_log
       WHERE started_at > now() - interval '7 days'
       GROUP BY job_name
      HAVING now() - max(started_at) > make_interval(mins => p_threshold_minutes)
       ORDER BY max(started_at)
       LIMIT 15
    ) s;

  RETURN jsonb_build_object(
    'ok', v_silence <= p_threshold_minutes,
    'silence_minutes', v_silence,
    'threshold_minutes', p_threshold_minutes,
    'newest_run_at', v_newest,
    'runs_last_hour', v_last_hour,
    'stale_jobs', v_stale
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_cron_fleet_silence(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cron_fleet_silence(int) TO service_role;

COMMENT ON FUNCTION public.fn_cron_fleet_silence(int) IS
  'How long since ANY Open Claw job last recorded a run. Silence is the signal: a 401 (or DNS, or a bad deploy) never reaches the logging layer, so a dead fleet shows up as an empty log rather than as failures. Threshold 25m is >2x the worst gap observed in a normal week (11m). Called by the GitHub-side watchdog, never by an Open Claw cron - a monitor must not share a failure domain with what it monitors.';

-- Post-apply assertions. This runs DURING the live outage, so the function is
-- expected to report not-ok; both branches are checked for shape.
DO $$
DECLARE v jsonb;
BEGIN
  SELECT public.fn_cron_fleet_silence(25) INTO v;
  IF NOT (v ? 'silence_minutes' AND v ? 'ok' AND v ? 'stale_jobs') THEN
    RAISE EXCEPTION 'post-apply failed: unexpected shape %', v;
  END IF;
  -- A threshold of a full year must be healthy on any log with recent history.
  SELECT public.fn_cron_fleet_silence(525600) INTO v;
  IF COALESCE((v->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'post-apply failed: a one-year threshold reported unhealthy %', v;
  END IF;
END $$;
