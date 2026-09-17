-- SOURCE-ONLY PROPOSAL. UNRUN. Existing job only; no second timer or payer.
-- Follow captured transition 00 before sealed155500, the remaining sealed
-- components, union continuation and timing01 in the same atomic bundle.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $cron_source_guard$
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'accounting_cron_requires_serializable' USING ERRCODE='25000';END IF;
 IF current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
    WHERE e.extname='pg_cron' AND d.classid='pg_class'::regclass
     AND d.objid=to_regclass('cron.job') AND d.deptype='e')
  OR NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
    WHERE e.extname='pg_cron' AND d.classid='pg_proc'::regclass
     AND d.objid=to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') AND d.deptype='e') THEN
  RAISE EXCEPTION 'accounting_cron_requires_actual_pg17_pg_cron';END IF;
 IF current_setting('cron.timezone',true) IS NULL
  OR current_setting('cron.timezone',true) NOT IN('GMT','UTC','Etc/UTC','America/Chicago','America/Los_Angeles') THEN
  RAISE EXCEPTION 'accounting_cron_timezone_requires_qualification';END IF;
END $cron_source_guard$;

-- The serializable snapshot and actual extension-owned update protect this
-- owned-job preimage without table-wide exclusion of unrelated cron writers.
DO $change_existing_job$
DECLARE
 job cron.job%ROWTYPE;
 before_row jsonb;
 after_row jsonb;
 expected_command text:=$close$
  SET statement_timeout = '2400s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','2400s',true) is not null
                      and public.fn_union_settlement_cascade_due() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $close$;
 final_command text:='SET statement_timeout=''2400s''; SELECT public.fn_union_settlement_cascade_due();';
 definition text;
BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-close')<>1
  OR EXISTS(SELECT 1 FROM cron.job WHERE jobname='union-weekly-rakeback-recompute') THEN
  RAISE EXCEPTION 'accounting_cron_single_authority_preimage_changed';END IF;
 SELECT * INTO job FROM cron.job WHERE jobname='union-weekly-rakeback-close';
 IF job.active IS DISTINCT FROM true OR job.schedule IS DISTINCT FROM '5,35 * * * *'
  OR job.command IS DISTINCT FROM expected_command OR job.database IS DISTINCT FROM current_database()
  OR job.username IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=job.username) THEN
  RAISE EXCEPTION 'accounting_cron_schedule_preimage_changed';END IF;
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO definition;
 IF md5(pg_get_functiondef('public.fn_process_weekly_accounting(uuid)'::regprocedure)) IS DISTINCT FROM '5aec6700bf043463e9db2933ca63bca1'
  OR position('AND v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval ''8 days'')) GROUP BY w.club_id' IN definition)=0
  OR position('-- A source writer may have held this period lock across the deadline,' IN definition)=0
  OR position('AND q.status=''complete'' AND q.result->>''success''=''true'' AND q.result->>''accounting_version''=''3''' IN definition)=0 THEN
  RAISE EXCEPTION 'accounting_cron_timing_predecessor_missing';END IF;
 before_row:=to_jsonb(job);
 -- Return the captured direct JSON result again after the sealed intermediate
 -- guard. IS NOT NULL would turn a refused result into a true query value.
 -- The coordinator retains its own transaction advisory lock.
 PERFORM cron.alter_job(job_id:=job.jobid,schedule:='0,30 * * * *',command:=final_command);
 SELECT to_jsonb(j) INTO after_row FROM cron.job j WHERE j.jobid=job.jobid;
 IF after_row IS DISTINCT FROM jsonb_set(jsonb_set(before_row,'{schedule}',to_jsonb('0,30 * * * *'::text)),
    '{command}',to_jsonb(final_command))
  OR (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-close')<>1 THEN
  RAISE EXCEPTION 'accounting_cron_changed_more_than_schedule';END IF;
END $change_existing_job$;
COMMIT;
