-- 20260823020000_db_saturation_selftest.sql
--
-- THE GUARD for the 2026-08-22 "no tables load, nothing is playing" outage.
--
-- Root cause recap (full detail in 20260822230941_autovacuum_tuning_hot_write_tables):
-- public.hand_history had NEVER been autovacuumed. Its visibility map was
-- therefore entirely unset, index-only scans on the hand-insert path degenerated
-- into random heap fetches over a 10 GB table, one hand insert cost 913 ms, the
-- instance saturated, and every unrelated query starved — the club lobby's table
-- list took 3,737 ms while reading only cached pages. Meanwhile two unguarded
-- pg_cron prune jobs overlapped themselves and rolled back every run, producing
-- dead tuples forever and reclaiming none.
--
-- WHY A GUARD IS NEEDED RATHER THAN JUST THE FIX
-- This was a RECURRENCE. Three hours earlier the same evening,
-- 20260822233000_prune_snapshots_bounded_scan.sql fixed one prune predicate
-- after the same class of saturation produced the same browser symptom Dan first
-- hit on 2026-08-20 ("Still Loading"). The fix was correct and incomplete, and
-- nothing was watching for the next occurrence, so it came back the same night.
--
-- Every condition below is one that was TRUE during the outage and is cheap to
-- detect. None of them are detectable from the application: the app just gets
-- slow, which reads as "the site is broken" and sends people hunting through
-- React routing — which is exactly where the first hours of this investigation
-- went before the database was measured.
--
-- Follows the house self-test shape (see fn_union_law_selftest, job 121):
-- a SECURITY DEFINER function returning {breaches, warnings}, run on a schedule.

CREATE TABLE IF NOT EXISTS public.db_saturation_selftest_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  breach_count int NOT NULL,
  warn_count   int NOT NULL,
  result       jsonb NOT NULL
);

COMMENT ON TABLE public.db_saturation_selftest_log IS
  'History of fn_db_saturation_selftest runs. Added 2026-08-22 after the '
  '"no tables load" outage so a recurrence is visible in data rather than '
  'only in player complaints.';

CREATE INDEX IF NOT EXISTS idx_db_saturation_selftest_log_ran_at
  ON public.db_saturation_selftest_log (ran_at DESC);

CREATE OR REPLACE FUNCTION public.fn_db_saturation_selftest()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_breaches jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_result   jsonb;
  r          record;
  -- Only tables big enough for bloat to actually hurt. Below this a missing
  -- vacuum is noise; above it, it is what took the platform down.
  c_big_bytes constant bigint := 500 * 1024 * 1024;
BEGIN
  -- ── CHECK 1 ────────────────────────────────────────────────────────────────
  -- A large table carrying real garbage that autovacuum is not clearing.
  -- hand_history sat at 234,091 dead tuples with autovacuum_count = 0 forever.
  FOR r IN
    SELECT s.relname,
           s.n_dead_tup,
           s.last_autovacuum,
           s.autovacuum_count,
           pg_total_relation_size(c.oid) AS bytes
      FROM pg_stat_user_tables s
      JOIN pg_class c ON c.oid = s.relid
     WHERE pg_total_relation_size(c.oid) > c_big_bytes
       AND s.n_dead_tup > 100000
       AND (s.last_autovacuum IS NULL OR s.last_autovacuum < now() - interval '6 hours')
       AND (s.last_vacuum     IS NULL OR s.last_vacuum     < now() - interval '6 hours')
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check',            'bloat_not_being_vacuumed',
      'table',            r.relname,
      'dead_tuples',      r.n_dead_tup,
      'autovacuum_count', r.autovacuum_count,
      'last_autovacuum',  r.last_autovacuum,
      'size',             pg_size_pretty(r.bytes),
      'why',              'Dead tuples are accumulating unreclaimed on a large table. '
                       || 'This is the exact shape of the 2026-08-22 outage: the visibility '
                       || 'map goes stale, index-only scans start fetching from the heap, '
                       || 'and the hand-insert path collapses. Check the per-table '
                       || 'autovacuum reloptions first.'
    );
  END LOOP;

  -- ── CHECK 2 ────────────────────────────────────────────────────────────────
  -- A large table the planner has NO statistics for. hand_history had
  -- last_analyze = NULL and last_autoanalyze = NULL, so the planner estimated
  -- 180 rows where 5,563 came back.
  FOR r IN
    SELECT s.relname, pg_total_relation_size(c.oid) AS bytes
      FROM pg_stat_user_tables s
      JOIN pg_class c ON c.oid = s.relid
     WHERE pg_total_relation_size(c.oid) > c_big_bytes
       AND s.last_analyze IS NULL
       AND s.last_autoanalyze IS NULL
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check', 'large_table_never_analyzed',
      'table', r.relname,
      'size',  pg_size_pretty(r.bytes),
      'why',   'The planner has no statistics for this table and will misestimate '
            || 'every join and scan against it.'
    );
  END LOOP;

  -- ── CHECK 3 ────────────────────────────────────────────────────────────────
  -- Autovacuum switched OFF on a large table. Nothing should ever do this here.
  FOR r IN
    SELECT c.relname
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'r'
       AND pg_total_relation_size(c.oid) > c_big_bytes
       AND array_to_string(coalesce(c.reloptions, '{}'), ',') ILIKE '%autovacuum_enabled=false%'
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check', 'autovacuum_disabled_on_large_table',
      'table', r.relname,
      'why',   'autovacuum_enabled=false on a large table guarantees the 2026-08-22 outage.'
    );
  END LOOP;

  -- ── CHECK 4 ────────────────────────────────────────────────────────────────
  -- A prune/cleanup cron job with no overlap guard. pg_cron starts a second copy
  -- of a job whose previous run is still going; that is how two prune jobs came
  -- to pin the disk. The house pattern is pg_try_advisory_lock (see job 76).
  FOR r IN
    SELECT jobid, jobname, schedule
      FROM cron.job
     WHERE active
       AND (jobname ILIKE '%prune%' OR command ILIKE '%sp_prune_%'
            OR jobname ILIKE '%cleanup%' OR jobname ILIKE '%sweep%')
       AND command NOT ILIKE '%pg_try_advisory_lock%'
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check',    'prune_job_without_overlap_guard',
      'jobid',    r.jobid,
      'job',      r.jobname,
      'schedule', r.schedule,
      'why',      'A cleanup job with no pg_try_advisory_lock guard can stack copies '
               || 'of itself and saturate the instance. Wrap it like job 76.'
    );
  END LOOP;

  -- ── CHECK 5 ────────────────────────────────────────────────────────────────
  -- A cron job routinely running long. Runs of 38-155 s on a */5 schedule are
  -- what made the prune overlap itself in the first place.
  FOR r IN
    SELECT j.jobname,
           round(avg(extract(epoch FROM (d.end_time - d.start_time)))::numeric, 1) AS avg_s,
           round(max(extract(epoch FROM (d.end_time - d.start_time)))::numeric, 1) AS max_s,
           count(*) AS runs
      FROM cron.job j
      JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.active
       AND d.status = 'succeeded'
       AND d.start_time > now() - interval '6 hours'
     GROUP BY j.jobname
    HAVING avg(extract(epoch FROM (d.end_time - d.start_time))) > 60
  LOOP
    v_warnings := v_warnings || jsonb_build_object(
      'check', 'cron_job_running_long',
      'job',   r.jobname,
      'avg_seconds', r.avg_s,
      'max_seconds', r.max_s,
      'runs',  r.runs,
      'why',   'Long runs starve everything else and risk overlapping the next run.'
    );
  END LOOP;

  -- ── CHECK 6 ────────────────────────────────────────────────────────────────
  -- Jobs that are failing. "job startup timeout" was one of the visible symptoms
  -- of saturation: pg_cron could not even get a connection.
  FOR r IN
    SELECT j.jobname,
           count(*) FILTER (WHERE d.status <> 'succeeded') AS failures,
           count(*) AS runs
      FROM cron.job j
      JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.active
       AND d.start_time > now() - interval '6 hours'
     GROUP BY j.jobname
    HAVING count(*) FILTER (WHERE d.status <> 'succeeded') > 2
  LOOP
    v_warnings := v_warnings || jsonb_build_object(
      'check',    'cron_job_failing',
      'job',      r.jobname,
      'failures', r.failures,
      'runs',     r.runs
    );
  END LOOP;

  v_result := jsonb_build_object(
    'checked_at', now(),
    'breaches',   v_breaches,
    'warnings',   v_warnings
  );

  INSERT INTO public.db_saturation_selftest_log (breach_count, warn_count, result)
  VALUES (jsonb_array_length(v_breaches), jsonb_array_length(v_warnings), v_result);

  -- Keep the log small and self-maintaining; this table must never become
  -- another thing that needs pruning.
  DELETE FROM public.db_saturation_selftest_log
   WHERE ran_at < now() - interval '30 days';

  IF jsonb_array_length(v_breaches) > 0 THEN
    RAISE WARNING 'db_saturation_selftest: % breach(es): %',
      jsonb_array_length(v_breaches), v_breaches;
  END IF;

  RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.fn_db_saturation_selftest() IS
  'Detects the conditions that caused the 2026-08-22 "no tables load" outage: '
  'unvacuumed/unanalyzed large tables, autovacuum disabled, and cleanup cron '
  'jobs without an overlap guard or running long. Added as the guard for that '
  'incident. Run by pg_cron job db-saturation-selftest every 30 minutes.';

-- Clients have no business running this; it reads server statistics.
REVOKE ALL ON FUNCTION public.fn_db_saturation_selftest() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_db_saturation_selftest() FROM anon, authenticated;

-- Schedule it. Precedent for a self-test on pg_cron in this database is
-- job 121, union-law-selftest.
DO $sched$
BEGIN
  PERFORM cron.unschedule('db-saturation-selftest')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'db-saturation-selftest');

  PERFORM cron.schedule(
    'db-saturation-selftest',
    '*/30 * * * *',
    $cmd$select public.fn_db_saturation_selftest()$cmd$
  );
END $sched$;

-- Post-apply assertions.
DO $assert$
DECLARE
  v jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'db-saturation-selftest' AND active) THEN
    RAISE EXCEPTION 'db-saturation-selftest was not scheduled';
  END IF;

  -- The guard must actually run, and must be honest about the state it finds.
  v := public.fn_db_saturation_selftest();
  IF v IS NULL OR NOT (v ? 'breaches') OR NOT (v ? 'warnings') THEN
    RAISE EXCEPTION 'fn_db_saturation_selftest returned an unexpected shape: %', v;
  END IF;

  RAISE NOTICE 'db_saturation_selftest baseline: % breach(es), % warning(s)',
    jsonb_array_length(v->'breaches'), jsonb_array_length(v->'warnings');
END $assert$;

-- ROLLBACK
--   select cron.unschedule('db-saturation-selftest');
--   drop function if exists public.fn_db_saturation_selftest();
--   drop table if exists public.db_saturation_selftest_log;
