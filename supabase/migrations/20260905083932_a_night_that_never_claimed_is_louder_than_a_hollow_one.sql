-- A NIGHT THAT NEVER CLAIMED IS LOUDER THAN A HOLLOW ONE (2026-09-05)
--
-- fn_horse_job_health, added hours ago in this same branch, joins every claim
-- in horse_job_runs to the rows that night produced and marks the hollow ones.
-- It found five hollow self_tuner nights and three hollow league nights on its
-- first run.
--
-- IT CANNOT SEE THE WORSE FAILURE. A job that stops claiming does not appear
-- at all, because the function iterates claims. Measured minutes after it
-- shipped:
--
--   horse_job_runs   last 'daily_audit' claim   2026-09-02
--   horse_daily_audit last row                  2026-09-04
--
-- The engine's nightly HorseDailyAudit has not claimed a night since
-- 2026-09-02, and the table still looks current because the Claude daily
-- analysis calls fn_run_horse_daily_audit itself and backfills the row. So the
-- evidence table is healthy, the job behind it is dead, and the health
-- function reports nothing because there is no claim to report on. That is the
-- estate's own stated failure mode, quoted in StableHandTags: "a job that stops
-- does not fill a log with errors, it stops filling it at all."
--
-- WHAT THIS ADDS. The function now walks a DATE SERIES rather than the claim
-- table, so every expected night appears with one of three verdicts:
--
--   ok       claimed, and the rows it should have written exist
--   hollow   claimed, and produced nothing        (a crashed run)
--   absent   never claimed at all                 (a dead scheduler)
--
-- `absent` is the new one and it is the one that was invisible. Expected
-- cadence is daily for every job here; league_pm is the afternoon rerun of
-- league and shares its evidence table, which is why both map to the same
-- count.
--
-- Still a QUERY and still refuses nothing. Nothing here blocks or retries a
-- claim: a guard that can refuse a nightly job can also strand it.

BEGIN;

DROP FUNCTION IF EXISTS public.fn_horse_job_health(integer);

CREATE OR REPLACE FUNCTION public.fn_horse_job_health(p_days integer DEFAULT 14)
RETURNS TABLE(
  job text,
  run_date date,
  status text,
  claimed_by text,
  claimed_at timestamptz,
  rows_produced bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH days AS (
    SELECT d::date AS run_date
      FROM generate_series(
             (now() AT TIME ZONE 'utc')::date - GREATEST(COALESCE(p_days, 14), 1),
             (now() AT TIME ZONE 'utc')::date - 1,   -- today is still in flight
             interval '1 day') d
  ),
  jobs(job) AS (
    VALUES ('self_tuner'), ('daily_audit'), ('league'), ('league_pm'),
           ('claude_daily_analysis')
  ),
  expected AS (
    SELECT j.job, d.run_date FROM jobs j CROSS JOIN days d
  )
  SELECT e.job,
         e.run_date,
         CASE
           WHEN r.job IS NULL          THEN 'absent'
           WHEN COALESCE(v.n, 0) = 0   THEN 'hollow'
           ELSE 'ok'
         END AS status,
         r.claimed_by,
         r.claimed_at,
         COALESCE(v.n, 0) AS rows_produced
    FROM expected e
    LEFT JOIN public.horse_job_runs r
      ON r.job = e.job AND r.run_date = e.run_date
    LEFT JOIN LATERAL (
      SELECT CASE e.job
        WHEN 'self_tuner' THEN
          (SELECT count(*) FROM public.horse_self_tune_log l WHERE l.run_date = e.run_date)
        WHEN 'daily_audit' THEN
          (SELECT count(*) FROM public.horse_daily_audit a WHERE a.day = e.run_date)
        WHEN 'league' THEN
          (SELECT count(*) FROM public.horse_league_results g WHERE g.run_date = e.run_date)
        WHEN 'league_pm' THEN
          (SELECT count(*) FROM public.horse_league_results g WHERE g.run_date = e.run_date)
        WHEN 'claude_daily_analysis' THEN
          (SELECT count(*) FROM public.horse_daily_audit a
            WHERE a.day = e.run_date AND a.agent_analyzed_at IS NOT NULL)
        ELSE NULL
      END AS n
    ) v ON true
   ORDER BY e.run_date DESC, e.job;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_job_health(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_job_health(integer) TO service_role;

COMMENT ON FUNCTION public.fn_horse_job_health(integer) IS
  'Every expected nightly horse job night, with status ok / hollow (claimed, produced nothing) / absent (never claimed - a dead scheduler, which iterating the claim table cannot see). Read-only; refuses nothing.';

-- Prove all three verdicts against the history that prompted this, rather than
-- trusting the join.
DO $verify$
DECLARE
  v_absent  integer;
  v_hollow  integer;
  v_ok      integer;
BEGIN
  SELECT count(*) FILTER (WHERE status = 'absent'),
         count(*) FILTER (WHERE status = 'hollow'),
         count(*) FILTER (WHERE status = 'ok')
    INTO v_absent, v_hollow, v_ok
    FROM public.fn_horse_job_health(10);

  RAISE NOTICE 'job health over 10 days: % ok, % hollow, % absent', v_ok, v_hollow, v_absent;

  -- daily_audit has not claimed since 2026-09-02; 09-03 must read absent.
  IF NOT EXISTS (
    SELECT 1 FROM public.fn_horse_job_health(10)
     WHERE job = 'daily_audit' AND run_date = DATE '2026-09-03' AND status = 'absent'
  ) THEN
    RAISE EXCEPTION 'daily_audit 2026-09-03 never claimed and did not read absent';
  END IF;

  -- self_tuner 2026-09-02 claimed and wrote nothing: still hollow, not absent.
  IF NOT EXISTS (
    SELECT 1 FROM public.fn_horse_job_health(10)
     WHERE job = 'self_tuner' AND run_date = DATE '2026-09-02' AND status = 'hollow'
  ) THEN
    RAISE EXCEPTION 'self_tuner 2026-09-02 claimed and produced nothing but did not read hollow';
  END IF;

  -- self_tuner 2026-09-04 wrote 386 rows: ok.
  IF NOT EXISTS (
    SELECT 1 FROM public.fn_horse_job_health(10)
     WHERE job = 'self_tuner' AND run_date = DATE '2026-09-04' AND status = 'ok'
  ) THEN
    RAISE EXCEPTION 'self_tuner 2026-09-04 wrote 386 tunes but did not read ok';
  END IF;
END
$verify$;

COMMIT;
