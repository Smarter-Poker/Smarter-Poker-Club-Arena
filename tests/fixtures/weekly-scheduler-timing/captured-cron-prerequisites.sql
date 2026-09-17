\set ON_ERROR_STOP on
-- UNRUN. Fresh disposable postgres database only. The protected executor must
-- preload actual pg_cron and disable launch BEFORE startup. Replace the old
-- historical-job prerequisite with this actual-capture seed; do not run both.
-- Capture: ../accounting-six-ledger-row-trace-0238.json, embedded timestamp
-- 2026-09-15T02:35:15.903162Z; SHA256
-- 6fbb1a35895c8f7e98db657f19751b6eb902d16d2fa6d3762ab7a4e2cb010f09.
DO $fixture_provider$
BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR current_setting('cron.launch_active_jobs',true) IS DISTINCT FROM 'off'
  OR current_setting('cron.database_name',true) IS DISTINCT FROM current_database()
  OR NOT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pg_cron') THEN
  RAISE EXCEPTION 'captured cron fixture requires disabled bound actual PG17 provider';END IF;
 IF to_regnamespace('cron') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  RAISE EXCEPTION 'captured cron fixture cannot use a synthetic cron schema';END IF;
END $fixture_provider$;
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $fixture_owned_objects$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
   WHERE e.extname='pg_cron' AND d.classid='pg_class'::regclass AND d.objid='cron.job'::regclass AND d.deptype='e')
  OR NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
   WHERE e.extname='pg_cron' AND d.classid='pg_proc'::regclass
    AND d.objid=to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') AND d.deptype='e')
  OR NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid JOIN pg_proc p ON p.oid=d.objid
   WHERE e.extname='pg_cron' AND d.classid='pg_proc'::regclass AND d.deptype='e'
    AND p.pronamespace='cron'::regnamespace AND p.proname='unschedule' AND p.pronargs=1
    AND p.proargtypes[0] IN('text'::regtype,'name'::regtype)) THEN
  RAISE EXCEPTION 'captured cron fixture requires actual extension-owned catalog and functions';END IF;
 IF EXISTS(SELECT 1 FROM cron.job) OR EXISTS(SELECT 1 FROM cron.job_run_details) THEN
  RAISE EXCEPTION 'captured cron fixture requires an unused job and run catalog';END IF;
END $fixture_owned_objects$;
-- Copy only public captured job metadata into the actual extension catalog.
-- In particular localhost:5432 is the captured destination, not this fixture's
-- socket/port. No command may launch. Do not use this seed against a live DB.
INSERT INTO cron.job(jobid,active,command,jobname,database,nodename,nodeport,schedule,username) VALUES
 (271,true,$recompute$
  SET statement_timeout = '600s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-recompute'))
             then (select set_config('statement_timeout','600s',true) is not null
                      and public.fn_rakeback_recompute_all_clubs() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $recompute$,'union-weekly-rakeback-recompute','postgres','localhost',5432,'45 6,7 * * 1','postgres'),
 (272,true,'SET statement_timeout=''2400s''; SELECT public.fn_union_settlement_cascade_due();',
  'union-weekly-rakeback-close','postgres','localhost',5432,'0,5,20,35 * * * *','postgres');
SELECT jsonb_build_object('fixture_seed','captured_actual_cron','launch_active_jobs',current_setting('cron.launch_active_jobs'),
 'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY j.jobid) FROM cron.job j));
