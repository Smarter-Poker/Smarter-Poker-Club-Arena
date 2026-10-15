CREATE OR REPLACE VIEW public.v_openclaw_job_staleness WITH (security_invoker = true) AS
 WITH s AS MATERIALIZED (
         SELECT cel.job_name,
            cel.started_at,
            lag(cel.started_at) OVER (PARTITION BY cel.job_name ORDER BY cel.started_at) AS prev_started_at
           FROM cron_execution_log cel
          WHERE cel.started_at > (now() - '30 days'::interval) AND cel.status = 'success'::text AND NOT (EXISTS ( SELECT 1
                   FROM ca_retired_cron_jobs r
                  WHERE r.job_name = cel.job_name))
        ), g AS (
         SELECT s.job_name,
            EXTRACT(epoch FROM s.started_at - s.prev_started_at) / 60.0 AS gap_minutes
           FROM s
          WHERE s.prev_started_at IS NOT NULL
        ), p AS MATERIALIZED (
         SELECT g.job_name,
            percentile_cont(0.9::double precision) WITHIN GROUP (ORDER BY (g.gap_minutes::double precision)) AS p90_gap_minutes
           FROM g
          GROUP BY g.job_name
        ), agg AS MATERIALIZED (
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
    a.successes_30d >= 5 AND a.silent_minutes::double precision > LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision) AS is_stale
   FROM agg a
     LEFT JOIN p ON p.job_name = a.job_name;
