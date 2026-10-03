-- 20261001152926_a_failing_hourly_cron_reaches_the_board.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A FAILING HOURLY CRON REACHES THE BOARD (2026-09-27). Detector only.
--
-- fn_ca_cron_failure_watch (cron ca-cron-health-30m) raised an incident only
-- for a job with >= 5 failures and 0 successes inside the last 2 HOURS. A job
-- that runs hourly can fail at most twice in two hours, so for every hourly or
-- slower job the rule could never fire. ca-conservation-sweep-hourly failed 23
-- of its 24 runs in the 24 h to 2026-09-27 16:40 UTC (15 of 16 that day, each
-- cancelled by statement_timeout, so the sweep recorded nothing for any of its
-- 30 conservation checks) and nothing reached ca_drift_incidents or
-- operational_alert_events. Measured at the same time, the same blind spot hid
-- rake-bbj-invariant-audit-hourly (15 of 24 failed), ca-settlement-correctness-30m
-- (13 of 24 failed) and ca-guard-defs-hourly (its last 3 runs failed).
--
-- THE RULE NOW, independent of a job's cadence. An active job is failing when
--   (a) its three most recent finished runs all failed and it has not
--       succeeded in the last 2 hours (for a per-minute job that is the old
--       rule: 120 straight failures), or
--   (b) in the last 24 hours it failed at least 5 times and more often than
--       it succeeded (a job that times out on most runs but not all).
-- The rule reads cron.job_run_details ONCE, bounded to the last 7 days.
-- That table keeps every run since 2026-08-06 (about 358k rows, 133 MB) and
-- its only index is the runid primary key, so a per-job "last three runs"
-- subquery with no time bound would scan the whole table once per active job
-- (about 125 full scans every 30 minutes, growing with retention). Instead one
-- window pass ranks each job's finished runs newest first, and both the
-- 24 hour counts and the last-three rule come from it.
-- Everything else is unchanged: the same incident source, dedup key per job
-- per day, severity (critical for an inventoried guard, else warning) and
-- routing through fn_ca_raise_drift_incident, whose incidents the intake
-- carries into operational_alert_events with the fleet target_task_id.
--
-- Law: tests/a-failing-hourly-cron-reaches-the-board.law.test.ts
-- Native proof: scripts/ci/test-cron-failure-watch-postgres.py

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_cron_failure_watch()'::regprocedure))
       IS DISTINCT FROM 'b07401212a118bc574611691e7bd152c' THEN
    RAISE EXCEPTION 'CRON_FAILURE_WATCH_PREIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
END
$pre$;

-- The catalog the restatement must keep (CREATE OR REPLACE keeps owner and
-- ACL; the post-image guard below proves it did).
CREATE TEMP TABLE _cron_watch_catalog ON COMMIT DROP AS
SELECT p.proowner, p.proacl, p.proconfig, p.prosecdef, p.provolatile
  FROM pg_proc p WHERE p.oid = 'public.fn_ca_cron_failure_watch()'::regprocedure;

CREATE OR REPLACE FUNCTION public.fn_ca_cron_failure_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0; v_is_guard boolean;
BEGIN
  FOR r IN
    -- ONE pass over a bounded window. cron.job_run_details is indexed only by
    -- runid, so a per-job "last 3 runs" lookup with no time bound is a full
    -- scan per active job. Here a single scan of the last 7 days ranks each
    -- job's finished runs newest first; the 24 hour counts and the last three
    -- finished runs both come from that one pass. A job that appears in the
    -- 24 hour window runs at least daily, so its last three finished runs fall
    -- inside 7 days.
    WITH runs AS (
      SELECT d.jobid, d.status, d.start_time, d.return_message,
             d.start_time > now() - interval '24 hours' AS in_day,
             CASE WHEN d.status IN ('failed', 'succeeded')
                  THEN row_number() OVER (PARTITION BY d.jobid, d.status IN ('failed', 'succeeded')
                                          ORDER BY d.start_time DESC)
             END AS finished_rank
        FROM cron.job_run_details d
       WHERE d.start_time > now() - interval '7 days'
    ),
    day AS (
      SELECT j.jobid, j.jobname,
             count(*) FILTER (WHERE x.in_day AND x.status = 'failed')    AS fails,
             count(*) FILTER (WHERE x.in_day AND x.status = 'succeeded') AS successes,
             max(x.start_time) FILTER (WHERE x.in_day AND x.status = 'succeeded') AS last_success,
             max(left(x.return_message, 200)) FILTER (WHERE x.in_day AND x.status = 'failed') AS sample_error,
             count(*) FILTER (WHERE x.finished_rank <= 3) AS finished,
             count(*) FILTER (WHERE x.finished_rank <= 3 AND x.status = 'failed') AS failed_in_a_row
        FROM cron.job j
        JOIN runs x ON x.jobid = j.jobid
       WHERE j.active
       GROUP BY j.jobid, j.jobname
      HAVING count(*) FILTER (WHERE x.in_day) > 0
    )
    SELECT day.*
      FROM day
     WHERE (day.finished = 3 AND day.failed_in_a_row = 3
            AND (day.last_success IS NULL OR day.last_success <= now() - interval '2 hours'))
        OR (day.fails >= 5 AND day.fails > day.successes)
     ORDER BY day.fails DESC, day.jobname
     LIMIT 20
  LOOP
    SELECT EXISTS (SELECT 1 FROM public.ca_guard_inventory g
                    WHERE g.kind = 'cron' AND g.object_a = r.jobname AND g.active)
      INTO v_is_guard;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_cron_failure_watch', 'unknown',
      CASE WHEN v_is_guard THEN 'critical' ELSE 'warning' END,
      'cron-failing:' || r.jobname || ':' || CURRENT_DATE::text,
      0, NULL, NULL, 'reporting', 'cron.job_run_details',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'scheduled job ' || r.jobname || ' failed ' || r.fails || ' of '
        || (r.fails + r.successes) || ' runs in 24h (last '
        || r.failed_in_a_row || ' of its last 3 failed; last success '
        || COALESCE(r.last_success::text, 'none in 24h') || '). Last error: '
        || COALESCE(r.sample_error, '?'),
      NULL, jsonb_build_object('jobname', r.jobname, 'fails_24h', r.fails,
                               'successes_24h', r.successes,
                               'failed_in_a_row', r.failed_in_a_row,
                               'last_success', r.last_success));
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

-- Operator telemetry: no browser role may run it; only the cron (postgres) and
-- service_role do. Live ACL is already {postgres=X/postgres,service_role=X/postgres},
-- so this restates it and the post-image guard below still holds.
REVOKE ALL ON FUNCTION public.fn_ca_cron_failure_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_cron_failure_watch() TO service_role;

-- The restated watch is exactly the reviewed body, with its catalog intact.
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p, _cron_watch_catalog c
     WHERE p.oid = 'public.fn_ca_cron_failure_watch()'::regprocedure
       AND md5(p.prosrc) = '81d2ad79b81b1f30c3d85b333396b5aa'
       AND p.proowner = c.proowner
       AND p.proacl IS NOT DISTINCT FROM c.proacl
       AND p.proconfig::text = '{search_path=public}'
       AND p.proconfig IS NOT DISTINCT FROM c.proconfig
       AND p.prosecdef AND c.prosecdef
       AND p.provolatile = c.provolatile) THEN
    RAISE EXCEPTION 'CRON_FAILURE_WATCH_POSTIMAGE: fn_ca_cron_failure_watch is not the reviewed definition'
      USING ERRCODE = '55000';
  END IF;
END
$post$;

-- fn_ca_cron_failure_watch is on fn_ca_guard_watchlist(): declare the change in
-- this transaction so fn_ca_guard_defs_watch records it instead of raising it.
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_cron_failure_watch', 'migration 20261001152926_a_failing_hourly_cron_reaches_the_board');

COMMIT;
