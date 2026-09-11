-- Fifteen alert and recording rules were written on 2026-09-04 against thirteen
-- metric names that nothing in the estate emits. In PromQL an absent metric
-- compared against a threshold yields an empty vector, which is not an error
-- and not a warning: the rule loads, shows green, and can never fire. Four of
-- the conditions those rules describe were true on 2026-09-11, two of them SMS
-- pages, and one had been true for 13.7 days.
--
-- This is the database half of the producer. One function returns every number
-- those rules need, in one round trip, so the collector on engine-01 is a curl
-- and a format rather than eleven queries. It reads only; it changes nothing.
--
-- It is SECURITY DEFINER because it reads cron.job_run_details, which the
-- service role cannot see, and because fn_settlement_health and
-- fn_undeclared_money_triggers are themselves definer functions granted to
-- service_role only. Grants below follow that same shape: nothing to PUBLIC.

BEGIN;

-- ── The Open Claw staleness view, without the quadratic p90 ──────────────────
--
-- The existing definition computes each job's p90 gap with a correlated
-- subquery over the whole 30-day gap set, once per job: 75 jobs x 80,834 rows,
-- 1,179 ms measured. The same numbers come out of one grouped aggregate. This
-- is a rewrite of HOW, not of WHAT; every column, type and value is unchanged,
-- and the five-success floor that stops the view judging a job it has too
-- little history for is preserved exactly.
CREATE OR REPLACE VIEW public.v_openclaw_job_staleness AS
  WITH s AS (
    SELECT cel.job_name,
           cel.started_at,
           lag(cel.started_at) OVER (PARTITION BY cel.job_name ORDER BY cel.started_at) AS prev_started_at
      FROM public.cron_execution_log cel
     WHERE cel.started_at > (now() - '30 days'::interval)
       AND cel.status = 'success'::text
       AND NOT EXISTS (SELECT 1 FROM public.ca_retired_cron_jobs r WHERE r.job_name = cel.job_name)
  ), g AS (
    SELECT s.job_name,
           EXTRACT(epoch FROM s.started_at - s.prev_started_at) / 60.0 AS gap_minutes
      FROM s
     WHERE s.prev_started_at IS NOT NULL
  ), p AS (
    SELECT g.job_name,
           percentile_cont(0.9::double precision) WITHIN GROUP (ORDER BY (g.gap_minutes::double precision)) AS p90_gap_minutes
      FROM g
     GROUP BY g.job_name
  ), agg AS (
    SELECT s.job_name,
           max(s.started_at) AS last_success_at,
           count(*) AS successes_30d,
           EXTRACT(epoch FROM now() - max(s.started_at)) / 60.0 AS silent_minutes
      FROM s
     GROUP BY s.job_name
  )
  SELECT a.job_name,
         a.last_success_at,
         a.successes_30d,
         round(a.silent_minutes, 2) AS silent_minutes,
         round(p.p90_gap_minutes::numeric, 2) AS p90_gap_minutes,
         round(LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision)::numeric, 2) AS threshold_minutes,
         a.successes_30d >= 5
           AND a.silent_minutes::double precision > LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision) AS is_stale
    FROM agg a
    LEFT JOIN p ON p.job_name = a.job_name;

COMMENT ON VIEW public.v_openclaw_job_staleness IS
  'Per-job Open Claw silence against that job''s own observed cadence. is_stale requires at least five successes in 30 days, so a job with too little history is reported but never judged - see OpenClawFleetLongSilence, which reads the worst STALE job, not the worst row.';

-- ── One read for every money, settlement and cron gauge ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_monitoring_health_snapshot(p_window_minutes integer DEFAULT 5)
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
  cron_openclaw_worst_silence_minutes  numeric
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
    -- The worst silence among jobs the view is willing to judge. Taking the
    -- worst row instead would pin this gauge to a job with one run in 30 days
    -- and leave OpenClawFleetLongSilence permanently lit, which is the same as
    -- off.
    SELECT count(*) FILTER (WHERE is_stale) AS stale,
           coalesce(max(silent_minutes) FILTER (WHERE is_stale), 0) AS worst_silence_minutes
      FROM public.v_openclaw_job_staleness
  ), ut AS (
    SELECT count(*) AS n FROM public.fn_undeclared_money_triggers()
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
         oc.worst_silence_minutes::numeric
    FROM sh, fa, pgc, oc, ut;
$function$;

COMMENT ON FUNCTION public.fn_monitoring_health_snapshot(integer) IS
  'Every number behind the money, settlement and cron alert rules, in one read. Called once a minute by collect-monitoring-health.sh on engine-01, which publishes the result as a node_exporter textfile. Read-only.';

REVOKE ALL ON FUNCTION public.fn_monitoring_health_snapshot(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_monitoring_health_snapshot(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_monitoring_health_snapshot(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_monitoring_health_snapshot(integer) TO service_role;

COMMIT;
