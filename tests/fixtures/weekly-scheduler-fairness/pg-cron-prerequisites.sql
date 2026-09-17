\set ON_ERROR_STOP on
-- UNRUN full-activation fixture prerequisite. Protected owner only.
-- Requires a qualified PostgreSQL 17 provider with actual pg_cron available
-- and shared_preload_libraries configured. The owner must configure the
-- disposable fixture's cron.database_name and cron.launch_active_jobs=off
-- before starting it. Do not replace the extension with local stand-in tables.
DO $prerequisite$
BEGIN
 IF current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
  RAISE EXCEPTION 'pending dependency: qualified PostgreSQL 17 fixture required';END IF;
 IF current_setting('cron.launch_active_jobs',true) IS DISTINCT FROM 'off' THEN
  RAISE EXCEPTION 'pending dependency: actual pg_cron must have job launching disabled';END IF;
 IF current_setting('cron.database_name',true) IS DISTINCT FROM current_database() THEN
  RAISE EXCEPTION 'pending dependency: pg_cron must be bound to this disposable fixture database';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pg_cron') THEN
  RAISE EXCEPTION 'pending dependency: actual pg_cron provider unavailable';END IF;
 IF to_regnamespace('cron') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  RAISE EXCEPTION 'fixture must not substitute a synthetic cron schema';END IF;
END $prerequisite$;
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $actual_extension$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
   WHERE e.extname='pg_cron' AND d.classid='pg_class'::regclass
    AND d.objid='cron.job'::regclass AND d.deptype='e')
  OR NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid JOIN pg_proc p ON p.oid=d.objid
   WHERE e.extname='pg_cron' AND d.classid='pg_proc'::regclass
    AND p.pronamespace='cron'::regnamespace AND p.proname='unschedule' AND p.pronargs=1
    AND p.proargtypes[0] IN('text'::regtype,'name'::regtype) AND d.deptype='e') THEN
  RAISE EXCEPTION 'fixture requires real pg_cron-owned job table and unschedule function';END IF;
 IF EXISTS(SELECT 1 FROM cron.job) THEN
  RAISE EXCEPTION 'fixture job catalog must be empty before seeding captured public commands';END IF;
END $actual_extension$;
-- active=true is intentional for exact migration guards. The actual extension
-- launcher is disabled above, so these fixture jobs cannot execute any command.
SELECT cron.schedule('union-weekly-rakeback-close','5,35 * * * *',$close$
  SET statement_timeout = '2400s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','2400s',true) is not null
                      and public.fn_union_settlement_cascade_due() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $close$);
SELECT cron.schedule('union-weekly-rakeback-recompute','45 6,7 * * 1',$recompute$
  SET statement_timeout = '600s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-recompute'))
             then (select set_config('statement_timeout','600s',true) is not null
                      and public.fn_rakeback_recompute_all_clubs() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $recompute$);
-- The full activation run uses its captured real legacy function definition,
-- not legacy-recompute-preimage.sql, whose cron stand-in is a unit-test seam.
