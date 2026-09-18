-- The installed weekly accounting transaction committed the correct job272
-- row, but the existing pg_cron1.6.4 launcher kept its old 0,5,20,35 cadence.
-- The upstream InvalidOid invalidation defect is fixed in pg_cron1.6.8; a
-- shared-invalidation overflow is consistent with, but not proven by, that
-- observation. The managed provider currently offers only1.6.4.
-- Submit the SAME canonical schedule through the native extension API in its
-- own short transaction, outside the earlier large DDL installation. This is
-- configuration adoption, not an extension upgrade or a new scheduler.
-- Apply this file separately, never concatenate it into a DDL bundle. Success
-- proves committed configuration only: natural :30 execution and absence of
-- the retired :35 cadence must still be observed before runtime acceptance.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $adopt_existing_accounting_schedule$
DECLARE
 expected_row constant jsonb := '{"jobid":272,"active":true,"jobname":"union-weekly-rakeback-close","schedule":"0,30 * * * *","command":"SET statement_timeout=''2400s''; SELECT public.fn_union_settlement_cascade_due();","database":"postgres","username":"postgres","nodename":"localhost","nodeport":5432}'::jsonb;
 before_other_jobs jsonb;
 after_other_jobs jsonb;
 observed_row jsonb;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'accounting_cron_adoption_requires_serializable' USING ERRCODE='25000';
 END IF;
 IF current_database()<>'postgres' OR current_user<>'postgres'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR current_setting('cron.database_name',true) IS DISTINCT FROM current_database()
  OR current_setting('cron.timezone',true) IS NULL
  OR current_setting('cron.timezone',true) NOT IN ('GMT','UTC','Etc/UTC') THEN
  RAISE EXCEPTION 'accounting_cron_adoption_provider_changed';
 END IF;
 -- No synthetic API, definer wrapper, or direct catalog UPDATE is admitted.
 IF NOT EXISTS(SELECT 1 FROM pg_extension e JOIN pg_depend d ON d.refobjid=e.oid
    JOIN pg_class c ON c.oid=d.objid
    WHERE e.extname='pg_cron' AND d.classid='pg_class'::regclass AND d.deptype='e'
      AND c.oid=to_regclass('cron.job') AND c.relkind='r' AND c.relowner=e.extowner)
  OR (SELECT count(*) FROM pg_extension e JOIN pg_depend d ON d.refobjid=e.oid
    JOIN pg_proc p ON p.oid=d.objid JOIN pg_language l ON l.oid=p.prolang
    WHERE e.extname='pg_cron' AND d.classid='pg_proc'::regclass AND d.deptype='e'
      AND p.proowner=e.extowner AND l.lanname='c' AND p.probin='$libdir/pg_cron'
      AND ((p.oid=to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') AND p.prosrc='cron_alter_job')
        OR (p.oid=to_regprocedure('cron.job_cache_invalidate()') AND p.prosrc='cron_job_cache_invalidate')))<>2
  OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('cron.job')
    AND tgname='cron_job_cache_invalidate' AND NOT tgisinternal AND tgenabled='O'
    AND tgtype=60 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid=to_regprocedure('cron.job_cache_invalidate()'))<>1 THEN
  RAISE EXCEPTION 'accounting_cron_adoption_requires_native_invalidation';
 END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobid=271 OR jobname='union-weekly-rakeback-recompute')
  OR (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-close')<>1 THEN
  RAISE EXCEPTION 'accounting_cron_adoption_single_authority_changed';
 END IF;
 SELECT to_jsonb(j) INTO observed_row FROM cron.job j WHERE jobid=272;
 IF observed_row IS DISTINCT FROM expected_row THEN
  RAISE EXCEPTION 'accounting_cron_adoption_preimage_changed';
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY jobid),'[]'::jsonb)
  INTO before_other_jobs FROM cron.job j WHERE jobid<>272;
 -- Even an unchanged schedule emits the native relation-specific invalidation.
 -- Only this existing row is written; the managed role needs no table LOCK.
 PERFORM cron.alter_job(job_id:=272,schedule:='0,30 * * * *');
 SELECT to_jsonb(j) INTO observed_row FROM cron.job j WHERE jobid=272;
 SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY jobid),'[]'::jsonb)
  INTO after_other_jobs FROM cron.job j WHERE jobid<>272;
 IF observed_row IS DISTINCT FROM expected_row OR after_other_jobs IS DISTINCT FROM before_other_jobs
  OR EXISTS(SELECT 1 FROM cron.job WHERE jobid=271 OR jobname='union-weekly-rakeback-recompute') THEN
  RAISE EXCEPTION 'accounting_cron_adoption_postimage_changed';
 END IF;
 RAISE NOTICE 'accounting_cron_schedule_adoption_requested_runtime_proof_pending';
END $adopt_existing_accounting_schedule$;
COMMIT;
