-- 20260823060000_selftest_detects_colliding_maintenance_jobs.sql
--
-- Adds CHECK 7 to fn_db_saturation_selftest: heavy maintenance jobs that fire
-- at the same time.
--
-- WHY: 20260823050000 fixed exactly this, and it was a defect I introduced one
-- migration earlier. Advisory-lock guards stop a job overlapping ITSELF but not
-- two different jobs starting together. Scheduling the prunes */5 and */10 and
-- the self-test */30 aligned them every 10 and 30 minutes:
--
--   02:20:00  snapshots 2.1 s   hand_history  7.0 s
--   02:30:00  snapshots 65.6 s  hand_history 78.3 s  selftest 26.9 s
--
-- Identical work, 10-30x slower, purely from self-inflicted contention. The
-- stagger is one cron.alter_job away from being undone, and nothing would have
-- noticed. Now the guard notices.
--
-- HOUR-AWARE ON PURPOSE. The first draft of this check compared MINUTES only
-- and immediately produced a false positive: cleanup-hole-cards (0 */6),
-- home-group-stale-sweep (0 2) and home-view-log-prune (0 3) all fire at minute
-- 0 but at different hours, so they never actually coincide. A guard that
-- reports jobs which cannot collide is the alert-fatigue failure this whole
-- series is about, so this compares real (hour, minute) firing slots.

CREATE OR REPLACE FUNCTION public.fn_cron_field(p_field text, p_max int)
RETURNS int[]
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_part text;
  v_out  int[] := '{}';
  v_step int;
BEGIN
  -- Returns NULL for any form this does not understand, so callers SKIP rather
  -- than guess. Guessing here manufactures false breaches.
  IF p_field IS NULL OR p_field = '' THEN RETURN NULL; END IF;
  IF p_field = '*' THEN RETURN ARRAY(SELECT generate_series(0, p_max)); END IF;

  FOREACH v_part IN ARRAY string_to_array(p_field, ',') LOOP
    IF v_part ~ '^\*/[0-9]+$' THEN
      v_step := substring(v_part from 3)::int;
      IF v_step <= 0 THEN RETURN NULL; END IF;
      v_out := v_out || ARRAY(SELECT g FROM generate_series(0, p_max) g WHERE g % v_step = 0);
    ELSIF v_part ~ '^[0-9]+$' THEN
      IF v_part::int > p_max THEN RETURN NULL; END IF;
      v_out := v_out || ARRAY[v_part::int];
    ELSE
      RETURN NULL;  -- ranges, step-on-range, names
    END IF;
  END LOOP;

  RETURN v_out;
END
$function$;

COMMENT ON FUNCTION public.fn_cron_field(text,int) IS
  'Expands one cron field (minute 0-59, hour 0-23) to the values it fires on. Returns NULL for forms it does not understand so callers skip rather than guess. Used by fn_db_saturation_selftest CHECK 7.';

-- The minute-only helper from the first draft is superseded; drop it so nobody
-- builds a new hour-blind check on it.
DROP FUNCTION IF EXISTS public.fn_cron_minutes(text);

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

  FOR r IN
    SELECT c.relname, pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       AND pg_total_relation_size(c.oid) > c_big_bytes
       AND NOT EXISTS (SELECT 1 FROM pg_stats st
                        WHERE st.schemaname='public' AND st.tablename=c.relname)
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check','large_table_never_analyzed','table',r.relname,'size',pg_size_pretty(r.bytes),
      'why','No rows in pg_stats for this table: the planner has no statistics and will misestimate every scan against it. Run ANALYZE.');
  END LOOP;

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

  -- CHECK 7: heavy maintenance jobs sharing a real (hour, minute) firing slot.
  FOR r IN
    WITH heavy AS (
      SELECT jobname,
             fn_cron_field(split_part(btrim(schedule),' ',1), 59) AS mins,
             fn_cron_field(split_part(btrim(schedule),' ',2), 23) AS hrs
        FROM cron.job
       WHERE active
         AND (jobname ILIKE '%prune%' OR command ILIKE '%sp_prune_%'
              OR jobname ILIKE '%cleanup%' OR jobname ILIKE '%sweep%'
              OR jobname ILIKE '%selftest%' OR jobname ILIKE '%vacuum%')
    ),
    slots AS (
      SELECT jobname, h * 60 + m AS slot
        FROM heavy, unnest(hrs) h, unnest(mins) m
       WHERE mins IS NOT NULL AND hrs IS NOT NULL
    )
    SELECT slot, array_agg(DISTINCT jobname ORDER BY jobname) AS jobs
      FROM slots
     GROUP BY slot
    HAVING count(DISTINCT jobname) > 1
     ORDER BY slot
     LIMIT 10
  LOOP
    v_warnings := v_warnings || jsonb_build_object(
      'check','maintenance_jobs_share_a_firing_slot',
      'at', lpad((r.slot / 60)::text, 2, '0') || ':' || lpad((r.slot % 60)::text, 2, '0'),
      'jobs', to_jsonb(r.jobs),
      'why','These heavy jobs fire at the same time and contend for the same disk. '
         || 'Measured 2026-08-23: the same prunes took 2.1s and 7.0s apart, and 65.6s '
         || 'and 78.3s when aligned. Advisory locks stop a job overlapping itself, not '
         || 'two jobs colliding. Give them offset minutes.');
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

REVOKE ALL ON FUNCTION public.fn_db_saturation_selftest() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_db_saturation_selftest() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_cron_field(text,int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_cron_field(text,int) FROM anon, authenticated;

DO $assert$
DECLARE
  v jsonb;
  v_collisions int;
BEGIN
  IF fn_cron_field('*/10', 59) <> ARRAY[0,10,20,30,40,50] THEN
    RAISE EXCEPTION 'fn_cron_field mis-parsed */10';
  END IF;
  IF fn_cron_field('3,13,23,33,43,53', 59) <> ARRAY[3,13,23,33,43,53] THEN
    RAISE EXCEPTION 'fn_cron_field mis-parsed a comma list';
  END IF;
  IF array_length(fn_cron_field('*', 23), 1) <> 24 THEN
    RAISE EXCEPTION 'fn_cron_field mis-parsed * for hours';
  END IF;
  IF fn_cron_field('1-5', 59) IS NOT NULL THEN
    RAISE EXCEPTION 'fn_cron_field must decline ranges rather than guess';
  END IF;
  IF fn_cron_field('99', 59) IS NOT NULL THEN
    RAISE EXCEPTION 'fn_cron_field must reject out-of-range values';
  END IF;

  v := public.fn_db_saturation_selftest();

  SELECT count(*) INTO v_collisions
    FROM jsonb_array_elements(v->'warnings') w
   WHERE w->>'check' = 'maintenance_jobs_share_a_firing_slot';

  IF v_collisions > 0 THEN
    RAISE EXCEPTION 'maintenance jobs still collide in % slot(s) - 20260823050000 did not hold', v_collisions;
  END IF;

  RAISE NOTICE 'selftest: % breach(es), % warning(s)',
    jsonb_array_length(v->'breaches'), jsonb_array_length(v->'warnings');
END $assert$;

-- ROLLBACK
--   drop function if exists public.fn_cron_field(text,int);
--   re-apply fn_db_saturation_selftest from
--   20260823040000_selftest_analyze_check_survives_restart.sql
