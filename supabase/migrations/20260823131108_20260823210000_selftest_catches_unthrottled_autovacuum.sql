-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823131108 "20260823210000_selftest_catches_unthrottled_autovacuum"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b50d44dea1b8f6f8bea715bcde99e610 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- CHECK 9: no table may have autovacuum_vacuum_cost_delay = 0.
--
-- I caused this outage twice in twenty minutes, so it gets a guard.
--
-- FIRST TIME (05:35 UTC): 20260822230941 left cost_delay = 0 on hand_history
-- (10 GB) after the emergency catch-up vacuum. One unthrottled worker -
-- "autovacuum: VACUUM ANALYZE public.hand_history, 9m46s, IO/DataFileRead" -
-- saturated the disk. /api/health returned HTTP 000 after 20 s.
--
-- SECOND TIME (05:52 UTC): 20260823200000 fixed only the three BIG tables. I
-- wrote, in that migration, that the small hot tables "cannot monopolise
-- anything" and left cost_delay = 0 on nine of them. That reasoning was wrong.
-- player_stats had taken 90 autovacuums and player_position_stats 64 - they fire
-- every ~30 seconds - so three unthrottled workers ran concurrently
-- (tournament_players, table_seats, player_position_stats) and saturated the
-- disk again. Individually trivial; collectively continuous.
--
-- The rule that survives both: cost_delay = 0 is an EMERGENCY setting for a
-- one-off catch-up, never a steady-state one. Size is irrelevant - what matters
-- is that an unthrottled worker never yields the disk, and there are three
-- worker slots.
--
-- Breach rather than warning: the symptom is the whole platform timing out.

CREATE OR REPLACE FUNCTION public.fn_unthrottled_autovacuum_tables()
RETURNS TABLE(relname text, reloptions text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.relname::text, array_to_string(c.reloptions, ', ')
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind = 'r'
     AND array_to_string(c.reloptions, ',') LIKE '%autovacuum_vacuum_cost_delay=0%';
$function$;

REVOKE ALL ON FUNCTION public.fn_unthrottled_autovacuum_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_unthrottled_autovacuum_tables() FROM anon, authenticated;

COMMENT ON FUNCTION public.fn_unthrottled_autovacuum_tables() IS
  'Tables whose autovacuum is unthrottled (cost_delay = 0). That is an emergency catch-up setting only; leaving it on caused two production outages on 2026-08-23. Used by fn_db_saturation_selftest CHECK 9.';

-- Wire it into the guard by appending CHECK 9 ahead of the result assembly.
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
      FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
     WHERE pg_total_relation_size(c.oid) > c_big_bytes
       AND s.n_dead_tup > 100000
       AND (s.last_autovacuum IS NULL OR s.last_autovacuum < now() - interval '6 hours')
       AND (s.last_vacuum     IS NULL OR s.last_vacuum     < now() - interval '6 hours')
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check','bloat_not_being_vacuumed','table',r.relname,
      'dead_tuples',r.n_dead_tup,'autovacuum_count',r.autovacuum_count,
      'last_autovacuum',r.last_autovacuum,'size',pg_size_pretty(r.bytes),
      'why','Dead tuples accumulating unreclaimed on a large table - the shape of the 2026-08-22 outage.');
  END LOOP;

  FOR r IN
    SELECT c.relname, pg_total_relation_size(c.oid) AS bytes FROM pg_class c
     WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
       AND pg_total_relation_size(c.oid) > c_big_bytes
       AND NOT EXISTS (SELECT 1 FROM pg_stats st WHERE st.schemaname='public' AND st.tablename=c.relname)
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check','large_table_never_analyzed','table',r.relname,'size',pg_size_pretty(r.bytes),
      'why','No rows in pg_stats: the planner has no statistics for this table.');
  END LOOP;

  FOR r IN
    SELECT c.relname FROM pg_class c
     WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
       AND pg_total_relation_size(c.oid) > c_big_bytes
       AND array_to_string(coalesce(c.reloptions,'{}'),',') ILIKE '%autovacuum_enabled=false%'
  LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check','autovacuum_disabled_on_large_table','table',r.relname,
      'why','autovacuum_enabled=false on a large table guarantees the 2026-08-22 outage.');
  END LOOP;

  -- CHECK 9: unthrottled autovacuum. Caused two outages on 2026-08-23.
  FOR r IN SELECT * FROM public.fn_unthrottled_autovacuum_tables() LIMIT 20 LOOP
    v_breaches := v_breaches || jsonb_build_object(
      'check','autovacuum_unthrottled','table',r.relname,'reloptions',r.reloptions,
      'why','autovacuum_vacuum_cost_delay = 0 means the worker never yields the disk. '
         || 'It is an emergency catch-up setting, not a steady-state one, and there are '
         || 'three worker slots so small tables collectively saturate just as well as one '
         || 'big one. Both 2026-08-23 outages were this. Use cost_delay = 2 with a raised '
         || 'cost_limit instead.');
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
      'why','A cleanup job with no pg_try_advisory_lock guard can stack copies of itself.');
  END LOOP;

  IF to_regclass('public.union_rake_weekly') IS NOT NULL THEN
    FOR r IN SELECT * FROM public.fn_union_rake_weekly_verify() LIMIT 10 LOOP
      v_breaches := v_breaches || jsonb_build_object(
        'check','rake_rollup_drift','union_id',r.union_id,'club_id',r.club_id,
        'week_start',r.week_start,'ledger',r.ledger,'rollup',r.rollup,
        'why','union_rake_weekly disagrees with union_wallet_transactions. Re-run the backfill in 20260823110000.');
    END LOOP;
  END IF;

  FOR r IN
    SELECT j.jobname,
           round(avg(extract(epoch FROM (d.end_time - d.start_time)))::numeric,1) AS avg_s,
           round(max(extract(epoch FROM (d.end_time - d.start_time)))::numeric,1) AS max_s,
           count(*) AS runs
      FROM cron.job j JOIN cron.job_run_details d ON d.jobid=j.jobid
     WHERE j.active AND d.status='succeeded' AND d.start_time > now() - interval '6 hours'
     GROUP BY j.jobname
    HAVING avg(extract(epoch FROM (d.end_time - d.start_time))) > 60
  LOOP
    v_warnings := v_warnings || jsonb_build_object(
      'check','cron_job_running_long','job',r.jobname,'avg_seconds',r.avg_s,
      'max_seconds',r.max_s,'runs',r.runs);
  END LOOP;

  FOR r IN
    SELECT j.jobname, count(*) FILTER (WHERE d.status<>'succeeded') AS failures, count(*) AS runs
      FROM cron.job j JOIN cron.job_run_details d ON d.jobid=j.jobid
     WHERE j.active AND d.start_time > now() - interval '6 hours'
     GROUP BY j.jobname
    HAVING count(*) FILTER (WHERE d.status<>'succeeded') > 2
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
       WHERE active AND (jobname ILIKE '%prune%' OR command ILIKE '%sp_prune_%'
              OR jobname ILIKE '%cleanup%' OR jobname ILIKE '%sweep%'
              OR jobname ILIKE '%selftest%' OR jobname ILIKE '%vacuum%')
    ), slots AS (
      SELECT jobname, h*60+m AS slot FROM heavy, unnest(hrs) h, unnest(mins) m
       WHERE mins IS NOT NULL AND hrs IS NOT NULL
    )
    SELECT slot, array_agg(DISTINCT jobname ORDER BY jobname) AS jobs
      FROM slots GROUP BY slot HAVING count(DISTINCT jobname) > 1 ORDER BY slot LIMIT 10
  LOOP
    v_warnings := v_warnings || jsonb_build_object(
      'check','maintenance_jobs_share_a_firing_slot',
      'at', lpad((r.slot/60)::text,2,'0')||':'||lpad((r.slot%60)::text,2,'0'),
      'jobs', to_jsonb(r.jobs));
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
DECLARE v jsonb; v_bad int;
BEGIN
  IF (SELECT count(*) FROM public.fn_unthrottled_autovacuum_tables()) > 0 THEN
    RAISE EXCEPTION 'there are still unthrottled tables - fix them before installing the guard';
  END IF;
  v := public.fn_db_saturation_selftest();
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v->'breaches') b
   WHERE b->>'check' = 'autovacuum_unthrottled';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'CHECK 9 reports % unthrottled table(s) immediately after the fix', v_bad;
  END IF;
END $assert$;
