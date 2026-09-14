-- Eight cron jobs are dispatched every few minutes, log status 'success', and
-- do nothing at all. Measured 2026-09-11:
--
--   /cron/horses-social-all      last real work 2026-09-04 20:00  (119.9h)
--   /cron/horses-stories         last real work 2026-09-06 17:05  (125.3h)
--   /cron/horse-posts            last real work 2026-09-06 17:10  (125.2h)
--   /cron/horses-social-friends  last real work 2026-09-06 18:15  (124.1h)
--   /cron/video-library-reels    last real work 2026-08-29 07:00  (327.4h)
--   /cron/phase6-content         never
--
-- 782 runs in ten days returned {"skipped":"engine_disabled","success":true}.
-- v_openclaw_job_staleness sees a fresh success and calls every one of them
-- healthy, so OpenClawJobsHaveGoneSilent cannot see them - not because a metric
-- was missing, but because A SKIP IS RECORDED AS A SUCCESS. That is the same
-- shape as the fifteen rules this branch revived: a check that cannot observe
-- the failure mode it exists for.
--
-- The cause is one boolean, content_settings.engine_enabled, false since
-- 2026-01-14 and never touched since. What changed in September was the code:
-- handlers began reading a switch that was already off, each going quiet on the
-- day its own handler shipped.
--
-- Whether that switch should be on is a product decision and is not made here.
-- What is made here is that the state stops being invisible.
--
-- The staleness view is deliberately NOT changed. It answers "is this job still
-- being dispatched", which is a true and separate fact, and a job that is
-- dispatched and no-ops is a different failure needing a different name.
--
-- A numeric `skipped` is a COUNT of items skipped by a job that did run
-- (/cron/freeroll-qualification-sync reports "0", /cron/scrape-sports-clips
-- reports "15"), so only a non-numeric string counts as a reason for skipping
-- everything. The 24-hour floor keeps a job that skipped once out of it.

BEGIN;

DROP FUNCTION IF EXISTS public.fn_monitoring_health_snapshot(integer);

CREATE FUNCTION public.fn_monitoring_health_snapshot(p_window_minutes integer DEFAULT 5)
RETURNS TABLE (
  settlement_window_minutes            integer,
  settlement_window_hands              bigint,
  settlement_failed                    bigint,
  settlement_stuck                     bigint,
  settlement_failure_rate              numeric,
  money_undeclared_triggers            bigint,
  financial_alerts_unresolved          bigint,
  financial_alerts_stale_critical      bigint,
  financial_alerts_distinct_conditions bigint,
  cron_pg_runs                         bigint,
  cron_pg_failures                     bigint,
  cron_openclaw_stale                  bigint,
  cron_openclaw_worst_silence_minutes  numeric,
  cron_jobs_skipping_all_work          bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
  WITH sh AS (
    SELECT * FROM public.fn_settlement_health(greatest(coalesce(p_window_minutes, 5), 1))
  ), fa AS (
    SELECT count(*) FILTER (WHERE NOT resolved) AS unresolved,
           count(*) FILTER (
             WHERE NOT resolved
               AND severity = 'critical'
               AND created_at < now() - interval '24 hours'
           ) AS stale_critical,
           count(DISTINCT source) FILTER (WHERE NOT resolved) AS distinct_conditions
      FROM public.financial_alerts
  ), pgc AS (
    SELECT count(*) AS runs,
           count(*) FILTER (WHERE status <> 'succeeded') AS failures
      FROM cron.job_run_details
     WHERE start_time > now() - interval '1 hour'
  ), oc AS (
    SELECT count(*) FILTER (WHERE is_stale) AS stale,
           coalesce(max(silent_minutes) FILTER (WHERE is_stale), 0) AS worst_silence_minutes
      FROM public.v_openclaw_job_staleness
  ), ut AS (
    SELECT count(*) AS n FROM public.fn_undeclared_money_triggers()
  ), runs AS MATERIALIZED (
    SELECT job_name, started_at, result,
           NOT (result ? 'skipped'
                AND jsonb_typeof(result -> 'skipped') = 'string'
                AND (result ->> 'skipped') !~ '^[0-9]+$') AS did_work
      FROM public.cron_execution_log
     WHERE started_at > now() - interval '30 days'
       AND status = 'success'
       AND NOT EXISTS (
             SELECT 1 FROM public.ca_retired_cron_jobs r WHERE r.job_name = cron_execution_log.job_name
           )
  ), latest AS (
    SELECT DISTINCT ON (job_name) job_name, result
      FROM runs ORDER BY job_name, started_at DESC
  ), latest_real AS (
    SELECT job_name, max(started_at) AS at FROM runs WHERE did_work GROUP BY 1
  ), noop AS (
    SELECT count(*) AS n
      FROM latest l
      LEFT JOIN latest_real lr ON lr.job_name = l.job_name
     WHERE l.result ? 'skipped'
       AND jsonb_typeof(l.result -> 'skipped') = 'string'
       AND (l.result ->> 'skipped') !~ '^[0-9]+$'
       AND (lr.at IS NULL OR lr.at < now() - interval '24 hours')
  )
  SELECT sh.window_minutes,
         sh.settled,
         sh.failed,
         sh.stuck,
         coalesce(sh.failure_rate, 0)::numeric,
         ut.n,
         fa.unresolved,
         fa.stale_critical,
         fa.distinct_conditions,
         pgc.runs,
         pgc.failures,
         oc.stale,
         oc.worst_silence_minutes::numeric,
         noop.n
    FROM sh, fa, pgc, oc, ut, noop;
$function$;

COMMENT ON FUNCTION public.fn_monitoring_health_snapshot(integer) IS
  'Every number behind the money, settlement and cron alert rules, in one read. Called once a minute by collect-monitoring-health.sh on engine-01, which publishes the result as a node_exporter textfile. Read-only. cron_jobs_skipping_all_work counts jobs whose most recent logged success carried a REASON for skipping (not a count) and which have done no real work in 24 hours.';

REVOKE ALL ON FUNCTION public.fn_monitoring_health_snapshot(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_monitoring_health_snapshot(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_monitoring_health_snapshot(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_monitoring_health_snapshot(integer) TO service_role;

COMMIT;
