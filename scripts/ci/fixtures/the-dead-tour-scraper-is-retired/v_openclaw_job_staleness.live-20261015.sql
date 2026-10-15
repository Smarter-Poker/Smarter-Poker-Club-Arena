-- public.v_openclaw_job_staleness as installed on production 2026-10-15 (after 20261015062953),
-- pg_get_viewdef(..., true) md5 4d54670add83d48e690321edfa3396f9.
CREATE VIEW public.v_openclaw_job_staleness WITH (security_invoker = true) AS
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
        ), fired AS MATERIALIZED (
         SELECT cel.job_name,
            min(cel.started_at) AS first_seen_at,
            count(*) FILTER (WHERE cel.started_at > (now() - '10 days'::interval)) AS fires_10d
           FROM cron_execution_log cel
          WHERE cel.started_at > (now() - '30 days'::interval) AND cel.status <> 'running'::text AND NOT (EXISTS ( SELECT 1
                   FROM ca_retired_cron_jobs r
                  WHERE r.job_name = cel.job_name))
          GROUP BY cel.job_name
        ), agg AS MATERIALIZED (
         SELECT f.job_name,
            COALESCE(a30.last_success_at, ( SELECT max(c.started_at) AS max
                   FROM cron_execution_log c
                  WHERE c.job_name = f.job_name AND c.status = 'success'::text)) AS last_success_at,
            COALESCE(a30.successes_30d, 0::bigint) AS successes_30d,
            f.first_seen_at,
            f.fires_10d
           FROM fired f
             LEFT JOIN ( SELECT s.job_name,
                    max(s.started_at) AS last_success_at,
                    count(*) AS successes_30d
                   FROM s
                  GROUP BY s.job_name) a30 ON a30.job_name = f.job_name
        ), m AS (
         SELECT agg.job_name,
            agg.last_success_at,
            agg.successes_30d,
            agg.fires_10d,
            EXTRACT(epoch FROM now() - COALESCE(agg.last_success_at, agg.first_seen_at)) / 60.0 AS silent_minutes
           FROM agg
        )
 SELECT m.job_name,
    m.last_success_at,
    m.successes_30d,
    round(m.silent_minutes, 2) AS silent_minutes,
    round(p.p90_gap_minutes::numeric, 2) AS p90_gap_minutes,
    round(
        CASE
            WHEN m.successes_30d >= 5 THEN LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision)
            ELSE 14400::double precision
        END::numeric, 2) AS threshold_minutes,
    m.successes_30d >= 5 AND m.silent_minutes::double precision > LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision) OR m.silent_minutes > 14400::numeric AND (m.successes_30d > 0 OR m.fires_10d >= 2) AS is_stale
   FROM m
     LEFT JOIN p ON p.job_name = m.job_name;
