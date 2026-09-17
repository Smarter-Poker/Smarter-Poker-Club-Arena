-- SOURCE-ONLY TRANSITION. UNRUN. Insert immediately before sealed component
-- 20260914155500; retain every frozen component byte. Root must compose this,
-- the sealed retirement, continuation and timing 01/02 in ONE transaction.
-- Actual input: accounting-six-ledger-row-trace-0238.json, captured_at
-- 2026-09-15T02:35:15.903162Z, SHA256
-- 6fbb1a35895c8f7e98db657f19751b6eb902d16d2fa6d3762ab7a4e2cb010f09.
-- No job is created or deleted here. The intermediate command must never be
-- presented as an independently deployed final scheduler state.
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $captured_cron_provider$
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'serializable' THEN
  RAISE EXCEPTION 'accounting_cron_requires_serializable' USING ERRCODE='25000';END IF;
 IF current_user<>'postgres' OR current_database()<>'postgres'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR current_setting('cron.database_name',true) IS DISTINCT FROM current_database()
  OR NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
    WHERE e.extname='pg_cron' AND d.classid='pg_class'::regclass
     AND d.objid=to_regclass('cron.job') AND d.deptype='e')
  OR NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
    WHERE e.extname='pg_cron' AND d.classid='pg_proc'::regclass
     AND d.objid=to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') AND d.deptype='e') THEN
  RAISE EXCEPTION 'captured_accounting_cron_requires_actual_provider';END IF;
END $captured_cron_provider$;

-- Serializable extension-API updates and the retained exact pre/postchecks
-- protect this owned-job transition. The retired-job checks remain necessary
-- for the extension's catalog-scan delete; unrelated cron writers are not locked.
DO $captured_cron_transition$
DECLARE
 original_close jsonb;
 original_recompute jsonb;
 other_jobs jsonb;
 expected_close jsonb:=jsonb_build_object('jobid',272,'active',true,
  'command','SET statement_timeout=''2400s''; SELECT public.fn_union_settlement_cascade_due();',
  'jobname','union-weekly-rakeback-close','database','postgres','nodename','localhost',
  'nodeport',5432,'schedule','0,5,20,35 * * * *','username','postgres');
 recompute_command text:=$recompute$
  SET statement_timeout = '600s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-recompute'))
             then (select set_config('statement_timeout','600s',true) is not null
                      and public.fn_rakeback_recompute_all_clubs() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $recompute$;
 expected_recompute jsonb;
 intermediate_command text:=$close$
  SET statement_timeout = '2400s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','2400s',true) is not null
                      and public.fn_union_settlement_cascade_due() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $close$;
BEGIN
 expected_recompute:=jsonb_build_object('jobid',271,'active',true,'command',recompute_command,
  'jobname','union-weekly-rakeback-recompute','database','postgres','nodename','localhost',
  'nodeport',5432,'schedule','45 6,7 * * 1','username','postgres');
 SELECT to_jsonb(j) INTO original_close FROM cron.job j WHERE j.jobid=272;
 SELECT to_jsonb(j) INTO original_recompute FROM cron.job j WHERE j.jobid=271;
 IF original_close IS DISTINCT FROM expected_close OR original_recompute IS DISTINCT FROM expected_recompute
  OR (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-close')<>1
  OR (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-recompute')<>1 THEN
  RAISE EXCEPTION 'captured_accounting_cron_preimage_changed';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.jobid),'[]'::jsonb) INTO other_jobs
  FROM cron.job j WHERE j.jobid NOT IN(271,272);

 PERFORM cron.alter_job(job_id:=272,schedule:='5,35 * * * *',command:=intermediate_command);

 IF (SELECT to_jsonb(j) FROM cron.job j WHERE j.jobid=272) IS DISTINCT FROM
     jsonb_set(jsonb_set(original_close,'{schedule}',to_jsonb('5,35 * * * *'::text)),
       '{command}',to_jsonb(intermediate_command))
  OR (SELECT to_jsonb(j) FROM cron.job j WHERE j.jobid=271) IS DISTINCT FROM original_recompute
  OR (SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.jobid),'[]'::jsonb)
       FROM cron.job j WHERE j.jobid NOT IN(271,272)) IS DISTINCT FROM other_jobs
  OR (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-close')<>1
  OR (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-recompute')<>1 THEN
  RAISE EXCEPTION 'captured_accounting_cron_transition_not_exact';END IF;
END $captured_cron_transition$;
COMMIT;
