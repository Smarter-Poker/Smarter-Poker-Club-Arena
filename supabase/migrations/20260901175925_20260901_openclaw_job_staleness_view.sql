-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901175925; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

BEGIN;

-- v_openclaw_job_staleness
--
-- WHY: on 2026-08-31 the Open Claw dispatcher's CRON_SECRET was rotated on
-- Vercel but not on the private workers VM. Every workers-routed job 401'd for
-- 25 hours (08:59:01 UTC -> 2026-09-01 17:21:17 UTC). Nothing noticed, because
-- a 401 is rejected by requireCronSecret BEFORE the cron_execution_log
-- middleware runs: the log does not fill with errors, it simply STOPS.
--
-- check-cron-liveness.mjs asks "ran >= 3 times and never succeeded" and cannot
-- see silence. check-cron-fleet-alive.mjs asks "has ANY job succeeded lately"
-- and cannot see ONE job going quiet while the fleet is noisy. This view is
-- the per-job member of that family: for every job with enough history to have
-- a baseline, how long has it been since its last SUCCESS, and how does that
-- compare with its own normal cadence.
--
-- The baseline is empirical (p90 of the gap between consecutive successes over
-- 30 days) rather than a hand-maintained schedule table, so it cannot drift
-- away from the dispatcher.
--
-- KNOWN LIMIT, stated rather than hidden: a job that fires less often than
-- roughly weekly will not reach successes_30d >= 5 and therefore has no
-- baseline here. Monthly jobs (vip-diamond-stipend) are NOT covered by this
-- view. They remain covered by check-cron-liveness.mjs's "never succeeds" rule.
CREATE OR REPLACE VIEW public.v_openclaw_job_staleness AS
WITH s AS (
  SELECT job_name,
         started_at,
         lag(started_at) OVER (PARTITION BY job_name ORDER BY started_at) AS prev_started_at
    FROM public.cron_execution_log
   WHERE started_at > now() - interval '30 days'
     AND status = 'success'
),
g AS (
  SELECT job_name,
         EXTRACT(EPOCH FROM (started_at - prev_started_at)) / 60.0 AS gap_minutes
    FROM s
   WHERE prev_started_at IS NOT NULL
),
agg AS (
  SELECT s.job_name,
         max(s.started_at)                                              AS last_success_at,
         count(*)                                                       AS successes_30d,
         EXTRACT(EPOCH FROM (now() - max(s.started_at))) / 60.0         AS silent_minutes,
         (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY g.gap_minutes)
            FROM g WHERE g.job_name = s.job_name)                       AS p90_gap_minutes
    FROM s
   GROUP BY s.job_name
)
SELECT a.job_name,
       a.last_success_at,
       a.successes_30d,
       round(a.silent_minutes::numeric, 2)   AS silent_minutes,
       round(a.p90_gap_minutes::numeric, 2)  AS p90_gap_minutes,
       -- Alert threshold: twice the job's own p90 cadence, never under 45
       -- minutes (so a minutely job is not alerted on one skipped fire), never
       -- over 10 days (so a weekly job that dies is still caught).
       round(LEAST(GREATEST(2 * a.p90_gap_minutes, 45), 14400)::numeric, 2) AS threshold_minutes,
       (a.successes_30d >= 5
        AND a.silent_minutes > LEAST(GREATEST(2 * a.p90_gap_minutes, 45), 14400)) AS is_stale
  FROM agg a;

COMMENT ON VIEW public.v_openclaw_job_staleness IS
  'Per-job silence detector over cron_execution_log. is_stale = this job has not '
  'succeeded within twice its own observed p90 cadence. Read by the workers route '
  '/cron/cron-staleness-watchdog. Added 2026-09-01 after the 25-hour CRON_SECRET '
  'skew outage, which no existing guard could see because a 401 never reaches the '
  'logging layer.';

GRANT SELECT ON public.v_openclaw_job_staleness TO service_role;

COMMIT;
