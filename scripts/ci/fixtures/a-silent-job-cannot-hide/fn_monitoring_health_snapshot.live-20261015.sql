CREATE OR REPLACE FUNCTION public.fn_monitoring_health_snapshot(p_window_minutes integer DEFAULT 5)
 RETURNS TABLE(settlement_window_minutes integer, settlement_window_hands bigint, settlement_failed bigint, settlement_stuck bigint, settlement_failure_rate numeric, money_undeclared_triggers bigint, financial_alerts_unresolved bigint, financial_alerts_stale_critical bigint, financial_alerts_distinct_conditions bigint, cron_pg_runs bigint, cron_pg_failures bigint, cron_openclaw_stale bigint, cron_openclaw_worst_silence_minutes numeric, cron_jobs_skipping_all_work bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
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
$function$
