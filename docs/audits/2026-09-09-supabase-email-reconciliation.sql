-- Read-only evidence queries. Execute each SELECT separately with Supabase
-- execute_sql, which may return only the final statement's result.
-- Fixed window: [2026-09-08 18:30:00 UTC, 2026-09-09 18:30:00 UTC).
-- Do not infer a capacity ceiling from these snapshots.

SELECT current_timestamp AS checked_at,
       current_setting('max_worker_processes') AS max_worker_processes,
       current_setting('cron.use_background_workers', true) AS cron_background_workers,
       current_setting('cron.max_running_jobs', true) AS cron_max_running_jobs,
       current_setting('max_connections') AS max_connections,
       current_setting('max_parallel_workers') AS max_parallel_workers,
       current_setting('max_parallel_workers_per_gather') AS per_gather,
       current_setting('max_logical_replication_workers') AS logical_workers;

SELECT count(*) AS jobs,
       count(*) FILTER (WHERE active) AS active,
       count(*) FILTER (WHERE active AND schedule = '* * * * *') AS every_minute
FROM cron.job;

SELECT status, count(*) AS runs,
       count(*) FILTER (WHERE return_message LIKE '%job startup timeout%') AS startup_timeout,
       count(*) FILTER (WHERE return_message LIKE '%deadlock detected%') AS deadlock,
       count(*) FILTER (WHERE return_message LIKE '%statement timeout%') AS statement_timeout,
       count(*) FILTER (WHERE return_message LIKE '%server restarted%') AS restart,
       count(*) FILTER (WHERE return_message LIKE '%cannot refresh materialized view%') AS refresh_error
FROM cron.job_run_details
WHERE start_time >= '2026-09-08T18:30:00Z'
  AND start_time < '2026-09-09T18:30:00Z'
GROUP BY status;

WITH runs AS (
  SELECT greatest(start_time, '2026-09-08T18:30:00Z'::timestamptz) AS s,
         least(end_time, '2026-09-09T18:30:00Z'::timestamptz) AS e
  FROM cron.job_run_details
  WHERE start_time < '2026-09-09T18:30:00Z'
    AND end_time > '2026-09-08T18:30:00Z'
    AND end_time >= start_time
), events AS (
  SELECT s AS t, 1 AS delta FROM runs
  UNION ALL SELECT e, -1 FROM runs
), grouped AS (
  SELECT t, sum(delta) AS delta FROM events GROUP BY t
), counts AS (
  SELECT t, sum(delta) OVER (ORDER BY t) AS concurrent,
         lead(t) OVER (ORDER BY t) AS next_t
  FROM grouped
)
SELECT max(concurrent) AS peak_completed_run_overlap,
       coalesce(sum(extract(epoch FROM (next_t - t))) FILTER (WHERE concurrent > 8), 0) AS seconds_above_8,
       coalesce(sum(extract(epoch FROM (next_t - t))) FILTER (WHERE concurrent >= 32), 0) AS seconds_at_least_32,
       (SELECT count(*) FROM cron.job_run_details
        WHERE end_time IS NULL
          AND start_time >= '2026-09-08T18:30:00Z'
          AND start_time < '2026-09-09T18:30:00Z') AS missing_end_in_window
FROM counts;

SELECT pubname, schemaname, tablename
FROM pg_publication_tables ORDER BY pubname, schemaname, tablename;

SELECT current_timestamp AS checked_at, entity::regclass::text AS table_name,
       count(*) AS subscription_rows
FROM realtime.subscription GROUP BY entity ORDER BY count(*) DESC;

SELECT event, status,
       CASE WHEN failure_reason LIKE 'digested_into:%'
            THEN 'digested_into' ELSE failure_reason END AS outcome,
       count(*) AS rows
FROM public.push_outbox
WHERE event IN ('tournament_reminder_15m', 'tournament_reminder_2m')
  AND created_at >= '2026-09-08T18:30:00Z'
  AND created_at < '2026-09-09T18:30:00Z'
GROUP BY event, status, outcome ORDER BY rows DESC;

SELECT conname, conrelid::regclass::text AS referencing_table,
       confrelid::regclass::text AS referenced_table,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE contype = 'f'
  AND (conrelid = to_regclass('public.commander_hand_history')
       OR confrelid = to_regclass('public.table_seats'))
ORDER BY referencing_table, conname;
