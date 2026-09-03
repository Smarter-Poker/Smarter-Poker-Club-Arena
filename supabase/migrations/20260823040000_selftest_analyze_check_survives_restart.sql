-- 20260823040000_selftest_analyze_check_survives_restart.sql
--
-- Fixes a false positive in fn_db_saturation_selftest (20260823020000).
--
-- CHECK 2 asked pg_stat_user_tables.last_analyze / last_autoanalyze IS NULL.
-- Those are RUNTIME COUNTERS and a postmaster restart wipes them. Real column
-- statistics live in pg_statistic and survive a restart untouched.
--
-- Observed 2026-08-23: Postgres restarted at 02:17:15Z. The 02:00 self-test run
-- had reported 0 breaches; the next reported 7 - the same seven large tables
-- that had been ANALYZEd an hour earlier and verified clean. Every one of them
-- still had real statistics (pg_stats showed 3-15 analyzed columns each). The
-- tables were fine; the check was wrong.
--
-- This matters more than a cosmetic miscount. The whole argument of
-- 20260823030000 was that a guard which always reports breaches is one people
-- learn to ignore, and a false positive on every database restart is precisely
-- that failure. Ask pg_stats, which is what the planner actually reads.

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
  c_big_bytes constant bigint := 500 * 1024 * 1024;
BEGIN
  -- CHECK 1: large table carrying real garbage nothing is reclaiming.
  -- n_dead_tup is also reset by a restart, so this goes quiet for a while after
  -- one and re-arms as garbage genuinely accumulates. That is the safe
  -- direction to be wrong in.
  FOR r IN
    SELECT s.relname, s.n_dead_tup, s.last_autovacuum, s.autovacuum_count,
           pg_total_relation_size(c.oid) AS bytes
      FROM pg_stat_user_tables s
      JOIN pg_class c ON c.oid = s.relid
     WHERE pg_total_relation_size(c.oid) > c_big_bytes
       AND s.n_dead_tup > 100000
       AND (s.last_autovacuum IS NULL OR s.last_autovacuum < now() - interval '6 hours')
       AND (s.last_vacuum     IS NULL OR s.last_vacuum     < now() - interval '6 hours')
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check','bloat_not_being_vacuumed','table',r.relname,
      'dead_tuples',r.n_dead_tup,'autovacuum_count',r.autovacuum_count,
      'last_autovacuum',r.last_autovacuum,'size',pg_size_pretty(r.bytes),
      'why','Dead tuples accumulating unreclaimed on a large table - the shape of the 2026-08-22 outage. Check per-table autovacuum reloptions.');
  END LOOP;

  -- CHECK 2: a large table the planner genuinely has no statistics for.
  -- Asks pg_stats (backed by pg_statistic, restart-durable), NOT last_analyze.
  FOR r IN
    SELECT c.relname, pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'r'
       AND pg_total_relation_size(c.oid) > c_big_bytes
       AND NOT EXISTS (
             SELECT 1 FROM pg_stats st
              WHERE st.schemaname = 'public' AND st.tablename = c.relname
           )
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check','large_table_never_analyzed','table',r.relname,'size',pg_size_pretty(r.bytes),
      'why','No rows in pg_stats for this table: the planner has no statistics and will misestimate every scan against it. Run ANALYZE.');
  END LOOP;

  -- CHECK 3: autovacuum switched off on a large table.
  FOR r IN
    SELECT c.relname FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       AND pg_total_relation_size(c.oid) > c_big_bytes
       AND array_to_string(coalesce(c.reloptions,'{}'),',') ILIKE '%autovacuum_enabled=false%'
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check','autovacuum_disabled_on_large_table','table',r.relname,
      'why','autovacuum_enabled=false on a large table guarantees the 2026-08-22 outage.');
  END LOOP;

  -- CHECK 4: cleanup cron job with no overlap guard.
  FOR r IN
    SELECT jobid, jobname, schedule FROM cron.job
     WHERE active
       AND (jobname ILIKE '%prune%' OR command ILIKE '%sp_prune_%'
            OR jobname ILIKE '%cleanup%' OR jobname ILIKE '%sweep%')
       AND command NOT ILIKE '%pg_try_advisory_lock%'
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check','prune_job_without_overlap_guard','jobid',r.jobid,'job',r.jobname,
      'schedule',r.schedule,
      'why','A cleanup job with no pg_try_advisory_lock guard can stack copies of itself and saturate the instance. Wrap it like job 76.');
  END LOOP;

  -- CHECK 5: cron job routinely running long.
  FOR r IN
    SELECT j.jobname,
           round(avg(extract(epoch FROM (d.end_time - d.start_time)))::numeric,1) AS avg_s,
           round(max(extract(epoch FROM (d.end_time - d.start_time)))::numeric,1) AS max_s,
           count(*) AS runs
      FROM cron.job j JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.active AND d.status = 'succeeded'
       AND d.start_time > now() - interval '6 hours'
     GROUP BY j.jobname
    HAVING avg(extract(epoch FROM (d.end_time - d.start_time))) > 60
  LOOP
    v_warnings := v_warnings || jsonb_build_object(
      'check','cron_job_running_long','job',r.jobname,'avg_seconds',r.avg_s,
      'max_seconds',r.max_s,'runs',r.runs,
      'why','Long runs starve everything else and risk overlapping the next run.');
  END LOOP;

  -- CHECK 6: cron job failing, over a recent window only.
  FOR r IN
    SELECT j.jobname,
           count(*) FILTER (WHERE d.status <> 'succeeded') AS failures,
           count(*) AS runs
      FROM cron.job j JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.active AND d.start_time > now() - interval '6 hours'
     GROUP BY j.jobname
    HAVING count(*) FILTER (WHERE d.status <> 'succeeded') > 2
  LOOP
    v_warnings := v_warnings || jsonb_build_object(
      'check','cron_job_failing','job',r.jobname,'failures',r.failures,'runs',r.runs);
  END LOOP;

  v_result := jsonb_build_object('checked_at', now(), 'breaches', v_breaches, 'warnings', v_warnings);

  INSERT INTO public.db_saturation_selftest_log (breach_count, warn_count, result)
  VALUES (jsonb_array_length(v_breaches), jsonb_array_length(v_warnings), v_result);

  DELETE FROM public.db_saturation_selftest_log WHERE ran_at < now() - interval '30 days';

  IF jsonb_array_length(v_breaches) > 0 THEN
    RAISE WARNING 'db_saturation_selftest: % breach(es): %', jsonb_array_length(v_breaches), v_breaches;
  END IF;

  RETURN v_result;
END
$function$;

-- Post-apply assertion: the seven tables that were ANALYZEd on 2026-08-22 and
-- then falsely re-flagged by the restart must NOT be reported now.
DO $assert$
DECLARE
  v jsonb;
  v_false_positives int;
BEGIN
  v := public.fn_db_saturation_selftest();

  SELECT count(*) INTO v_false_positives
    FROM jsonb_array_elements(v->'breaches') b
   WHERE b->>'check' = 'large_table_never_analyzed'
     AND EXISTS (SELECT 1 FROM pg_stats st
                  WHERE st.schemaname='public' AND st.tablename = b->>'table');

  IF v_false_positives > 0 THEN
    RAISE EXCEPTION 'still reporting % table(s) as never-analyzed that have real pg_stats rows', v_false_positives;
  END IF;

  RAISE NOTICE 'selftest after fix: % breach(es), % warning(s)',
    jsonb_array_length(v->'breaches'), jsonb_array_length(v->'warnings');
END $assert$;

-- ROLLBACK: re-apply the CHECK 2 body from
-- 20260823020000_db_saturation_selftest.sql. Not advised - it reintroduces a
-- false positive on every database restart.
