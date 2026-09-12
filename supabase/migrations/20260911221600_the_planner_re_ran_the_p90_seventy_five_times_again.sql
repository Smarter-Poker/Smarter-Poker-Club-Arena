-- Migration 20260911220500 replaced the correlated p90 subquery in
-- v_openclaw_job_staleness with a grouped aggregate joined once. Standalone,
-- that is 260 ms against the previous 1,179 ms, and it was verified row for row.
--
-- Inlined into a larger query it is not. Measured immediately after applying:
-- fn_monitoring_health_snapshot() took 6,387 ms while the sum of its five parts
-- measured individually was 657 ms. The plan shows why - the planner chose a
-- Nested Loop Left Join and re-executed the p90 GroupAggregate once per outer
-- row, 75 loops over 59,602 rows each:
--
--   ->  GroupAggregate (actual time=0.163..67.196 rows=38 loops=75)
--         ->  CTE Scan on s s_1 (actual time=0.001..12.291 rows=59602 loops=75)
--
-- which is the same quadratic shape the rewrite removed, reintroduced by the
-- planner rather than by the SQL. A join written once is not a join evaluated
-- once, and nothing in the view could promise otherwise.
--
-- MATERIALIZED is that promise. It costs a little when the view is read alone
-- and it is what makes the cost predictable when it is read as part of
-- something else: 6,387 ms to 485 ms for the whole snapshot. This view is read
-- every sixty seconds by a collector, so predictable is the property that
-- matters.
--
-- Semantics are untouched. MATERIALIZED changes when a CTE is evaluated, never
-- what it returns.

BEGIN;

CREATE OR REPLACE VIEW public.v_openclaw_job_staleness AS
  WITH s AS MATERIALIZED (
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
         a.successes_30d >= 5
           AND a.silent_minutes::double precision > LEAST(GREATEST(2::double precision * p.p90_gap_minutes, 45::double precision), 14400::double precision) AS is_stale
    FROM agg a
    LEFT JOIN p ON p.job_name = a.job_name;

COMMIT;
