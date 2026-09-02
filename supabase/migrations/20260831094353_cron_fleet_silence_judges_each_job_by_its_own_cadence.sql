-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831094353; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ─────────────────────────────────────────────────────────────────────────────
-- AN ALARM PEOPLE CAN TRUST (2026-08-31, same day as the first cut)
--
-- The first version of fn_cron_fleet_silence listed every job quiet for longer
-- than the fleet threshold. Reading its first real output immediately showed
-- why that is wrong: the top entries were auto-settlement (10,062 minutes),
-- auto-settlement-distribute and rakeback-period-settle. Those are WEEKLY jobs
-- - Monday 10:00, 10:10 and 10:30 - so seven days of quiet is exactly correct
-- behaviour, and solver-watchdog, also near the top, was retired on 2026-08-27.
--
-- An alarm whose detail section is mostly healthy weekly jobs and a retired one
-- is an alarm people learn to scroll past. That is the same failure the cron
-- log itself had: 99% noise, so the real thing hid in it.
--
-- So each job is now judged AGAINST ITS OWN HISTORY. The median gap between a
-- job's runs is what that job normally does; being quiet for more than three
-- times its own median, and at least the fleet threshold, is what is odd for
-- THAT job. A weekly job has a median around 10,080 minutes and no longer
-- appears; a job that runs every minute and has been quiet for half an hour
-- does. Jobs with fewer than three runs in the window are skipped, because two
-- points do not establish a cadence.
--
-- The FLEET verdict (`ok`) is unchanged and remains the real signal: if
-- nothing at all has recorded a run for longer than the threshold, the whole
-- fleet is down regardless of what any individual job's cadence is.
--
-- ROLLBACK: re-apply the previous body from
--   supabase/migrations/*fn_cron_fleet_silence_detects_a_dead_fleet*
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

  -- Jobs late BY THEIR OWN STANDARD. median gap from 14 days of history, so a
  -- weekly job is measured against a week and a per-minute job against a
  -- minute. Late = quiet for > 3x its own median AND at least the fleet
  -- threshold, so a fast job cannot alarm on one skipped tick.
  WITH gaps AS (
    SELECT job_name,
           started_at - lag(started_at) OVER (PARTITION BY job_name ORDER BY started_at) AS gap
      FROM public.cron_execution_log
     WHERE started_at > now() - interval '14 days'
  ),
  cadence AS (
    SELECT job_name,
           count(*) FILTER (WHERE gap IS NOT NULL) AS observations,
           EXTRACT(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))/60.0 AS median_min
      FROM gaps
     GROUP BY job_name
    HAVING count(*) FILTER (WHERE gap IS NOT NULL) >= 3
  ),
  last_seen AS (
    SELECT job_name, max(started_at) AS last_at
      FROM public.cron_execution_log
     WHERE started_at > now() - interval '14 days'
     GROUP BY job_name
  )
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'job', c.job_name,
             'quiet_minutes', round(EXTRACT(epoch FROM (now() - l.last_at))/60.0, 1),
             'normal_gap_minutes', round(c.median_min::numeric, 1)
           ) ORDER BY (EXTRACT(epoch FROM (now() - l.last_at))/60.0) / NULLIF(c.median_min, 0) DESC
         ), '[]'::jsonb)
    INTO v_stale
    FROM cadence c
    JOIN last_seen l USING (job_name)
   WHERE c.median_min > 0
     AND EXTRACT(epoch FROM (now() - l.last_at))/60.0 > GREATEST(c.median_min * 3, p_threshold_minutes);

  RETURN jsonb_build_object(
    'ok', v_silence <= p_threshold_minutes,
    'silence_minutes', v_silence,
    'threshold_minutes', p_threshold_minutes,
    'newest_run_at', v_newest,
    'runs_last_hour', v_last_hour,
    'late_jobs', v_stale
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_cron_fleet_silence(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cron_fleet_silence(int) TO service_role;

COMMENT ON FUNCTION public.fn_cron_fleet_silence(int) IS
  'Fleet verdict: how long since ANY Open Claw job recorded a run (silence is the signal - a 401 never reaches the logging layer, so a dead fleet shows as an EMPTY log, not as failures). late_jobs judges each job against its own median gap over 14 days, so weekly jobs and retired ones stay out of the report. Threshold 25m is >2x the worst gap in a normal week (11m). Called by the GitHub-side watchdog, never by an Open Claw cron.';

DO $$
DECLARE v jsonb; v_late jsonb;
BEGIN
  SELECT public.fn_cron_fleet_silence(25) INTO v;
  IF NOT (v ? 'silence_minutes' AND v ? 'ok' AND v ? 'late_jobs') THEN
    RAISE EXCEPTION 'post-apply failed: unexpected shape %', v;
  END IF;

  -- The weekly settlement jobs must NOT appear: seven days of quiet is their
  -- normal cadence, and listing them is exactly the noise this cut removes.
  v_late := v -> 'late_jobs';
  IF v_late::text LIKE '%auto-settlement%' THEN
    RAISE EXCEPTION 'post-apply failed: a weekly job is still being reported as late: %', v_late;
  END IF;

  SELECT public.fn_cron_fleet_silence(525600) INTO v;
  IF COALESCE((v->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'post-apply failed: a one-year threshold reported unhealthy %', v;
  END IF;
END $$;
