-- 20260823130000_selftest_watches_rake_rollup_drift.sql
--
-- CHECK 8: the rake rollup must equal the ledger.
--
-- 20260823110000 introduced union_rake_weekly as derived display data behind
-- fn_club_money_panel, maintained by an AFTER INSERT trigger. It is exact today
-- and the migration proved it, but it rests on a stated assumption: that
-- union_wallet_transactions is append-only. If anyone ever adds an UPDATE or
-- DELETE path to that ledger, the trigger will not see it and the rollup will
-- silently drift - and a money panel that is quietly wrong is worse than a slow
-- one.
--
-- fn_union_rake_weekly_verify() already proves equality on demand. This wires it
-- into the guard that runs every 30 minutes, so drift is caught in data rather
-- than by someone noticing a number looks off. It is a BREACH, not a warning:
-- the panel showing wrong money is not a performance nuisance.
--
-- Checks 1-7 are unchanged from 20260823060000; the whole body is restated
-- because CREATE OR REPLACE replaces the whole body.

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

  -- CHECK 8: rake rollup drift. Breach, not warning - wrong money on a panel.
  IF to_regclass('public.union_rake_weekly') IS NOT NULL THEN
    FOR r IN SELECT * FROM public.fn_union_rake_weekly_verify() LIMIT 10 LOOP
      v_breaches := v_breaches || jsonb_build_object(
        'check','rake_rollup_drift',
        'union_id', r.union_id, 'club_id', r.club_id, 'week_start', r.week_start,
        'ledger', r.ledger, 'rollup', r.rollup,
        'why','union_rake_weekly disagrees with union_wallet_transactions. The rollup is '
           || 'maintained by an AFTER INSERT trigger and assumes the ledger is append-only; '
           || 'an UPDATE or DELETE path would cause exactly this. fn_club_money_panel is '
           || 'showing the rollup number. Re-run the backfill in 20260823110000 to repair.');
    END LOOP;
  END IF;

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
      FROM slots GROUP BY slot HAVING count(DISTINCT jobname) > 1
     ORDER BY slot LIMIT 10
  LOOP
    v_warnings := v_warnings || jsonb_build_object(
      'check','maintenance_jobs_share_a_firing_slot',
      'at', lpad((r.slot / 60)::text, 2, '0') || ':' || lpad((r.slot % 60)::text, 2, '0'),
      'jobs', to_jsonb(r.jobs),
      'why','These heavy jobs fire at the same time and contend for the same disk. '
         || 'Advisory locks stop a job overlapping itself, not two jobs colliding.');
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

DO $assert$
DECLARE v jsonb; v_drift int;
BEGIN
  v := public.fn_db_saturation_selftest();
  SELECT count(*) INTO v_drift FROM jsonb_array_elements(v->'breaches') b
   WHERE b->>'check' = 'rake_rollup_drift';
  IF v_drift > 0 THEN
    RAISE EXCEPTION 'rake rollup is already drifting in % group(s)', v_drift;
  END IF;
  RAISE NOTICE 'selftest: % breach(es), % warning(s)',
    jsonb_array_length(v->'breaches'), jsonb_array_length(v->'warnings');
END $assert$;

-- ROLLBACK: re-apply fn_db_saturation_selftest from
-- 20260823060000_selftest_detects_colliding_maintenance_jobs.sql (drops CHECK 8).
