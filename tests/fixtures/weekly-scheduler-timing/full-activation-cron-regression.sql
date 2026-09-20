\set ON_ERROR_STOP on
-- UNRUN. Run only after the complete atomic candidate in the actual pg_cron
-- fixture. This observes a disabled job catalog, never a real launch/payment.
DO $catalog$
DECLARE observed jsonb; due timestamptz;
BEGIN
 IF current_setting('cron.launch_active_jobs',true) IS DISTINCT FROM 'off'
  OR current_setting('cron.database_name',true) IS DISTINCT FROM current_database()
  OR EXISTS(SELECT 1 FROM cron.job_run_details)
 THEN RAISE EXCEPTION 'full accounting fixture launcher was not disabled'; END IF;
 SELECT to_jsonb(j) INTO observed FROM cron.job j WHERE j.jobid=272;
 IF observed IS DISTINCT FROM jsonb_build_object('jobid',272,'active',true,
   'command','SET statement_timeout=''2400s''; SELECT public.fn_union_settlement_cascade_due();',
   'jobname','union-weekly-rakeback-close','database','postgres','nodename','localhost',
   'nodeport',5432,'schedule','0,30 * * * *','username','postgres')
  OR (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-close')<>1
  OR EXISTS(SELECT 1 FROM cron.job WHERE jobid=271 OR jobname='union-weekly-rakeback-recompute')
 THEN RAISE EXCEPTION 'full accounting final scheduler contract differs from recorded input'; END IF;
 FOREACH due IN ARRAY ARRAY[public.fn_union_accounting_run_at('2026-03-09 07:00Z'),
   public.fn_union_accounting_run_at('2026-11-02 08:00Z')] LOOP
  IF (due AT TIME ZONE 'America/Chicago')::time IS DISTINCT FROM time '04:00'
   OR extract(minute FROM due AT TIME ZONE current_setting('cron.timezone')) IS DISTINCT FROM 0::numeric
  THEN RAISE EXCEPTION 'final cron schedule misses the Chicago due-time opportunity'; END IF;
 END LOOP;
 RAISE NOTICE 'PASS: final actual scheduler preserves JSON result visibility, one authority and both Chicago DST opportunities';
END $catalog$;
