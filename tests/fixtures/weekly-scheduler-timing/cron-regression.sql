\set ON_ERROR_STOP on
-- UNRUN. Requires actual captured job271/272 input, the full24 fixture with00
-- before155500, continuation and timing01, with real pg_cron launch disabled.
-- Do not run against load.sql's minimal unit schema or production.
DO $$BEGIN
 IF current_setting('cron.launch_active_jobs',true) IS DISTINCT FROM 'off'
  OR current_setting('cron.database_name',true) IS DISTINCT FROM current_database()
 THEN RAISE EXCEPTION 'cron timing fixture requires a bound disabled actual launcher';END IF;
END$$;
-- A real extension-owned unrelated job tests catalog isolation. It cannot
-- launch in this fixture and is never part of the production successor.
SELECT cron.schedule('fixture-timing-unrelated','17 * * * *','SELECT 1');
CREATE TEMP TABLE timing_cron_before AS SELECT to_jsonb(j) AS value FROM cron.job j WHERE jobname='union-weekly-rakeback-close';
CREATE TEMP TABLE timing_other_jobs_before AS SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.jobid),'[]'::jsonb) AS value FROM cron.job j WHERE jobname<>'union-weekly-rakeback-close';
CREATE TEMP TABLE timing_cron_runs_before AS SELECT count(*) AS n FROM cron.job_run_details;
\ir ../../../supabase/accounting/weekly-v3/components/20260914163000_canonical_cron_wakes_on_the_hour.sql
DO $actual_cron_assertions$
DECLARE old_row jsonb;new_row jsonb;others jsonb;due timestamptz;
 final_command text:='SET statement_timeout=''2400s''; SELECT public.fn_union_settlement_cascade_due();';
 captured_final jsonb;
BEGIN
 SELECT value INTO STRICT old_row FROM timing_cron_before;
 SELECT to_jsonb(j) INTO STRICT new_row FROM cron.job j WHERE jobname='union-weekly-rakeback-close';
 captured_final:=jsonb_build_object('jobid',272,'active',true,'command',final_command,
  'jobname','union-weekly-rakeback-close','database','postgres','nodename','localhost',
  'nodeport',5432,'schedule','0,30 * * * *','username','postgres');
 IF new_row IS DISTINCT FROM jsonb_set(jsonb_set(old_row,'{schedule}',to_jsonb('0,30 * * * *'::text)),
    '{command}',to_jsonb(final_command)) OR new_row IS DISTINCT FROM captured_final THEN
  RAISE EXCEPTION 'FAIL: final canonical job differs from captured input beyond the admitted schedule';END IF;
 RAISE NOTICE 'PASS: actual job272 changes only schedule from captured input and preserves its direct JSON result';
 SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.jobid),'[]'::jsonb) INTO others FROM cron.job j WHERE jobname<>'union-weekly-rakeback-close';
 IF others IS DISTINCT FROM (SELECT value FROM timing_other_jobs_before)
  OR EXISTS(SELECT 1 FROM cron.job WHERE jobname='union-weekly-rakeback-recompute') THEN
  RAISE EXCEPTION 'FAIL: scheduler timing changed another job or restored retired recompute';END IF;
 RAISE NOTICE 'PASS: unrelated actual jobs and retired recompute state are preserved';
 FOREACH due IN ARRAY ARRAY[public.fn_union_accounting_run_at('2026-03-09 07:00Z'),public.fn_union_accounting_run_at('2026-11-02 08:00Z')] LOOP
  IF extract(minute FROM due AT TIME ZONE current_setting('cron.timezone'))<>0
   OR (due AT TIME ZONE 'America/Chicago')::time<>time '04:00' THEN
   RAISE EXCEPTION 'FAIL: admitted scheduler timezone lacks the Chicago four oclock opportunity';END IF;
 END LOOP;
 RAISE NOTICE 'PASS: canonical zero-minute schedule includes both Chicago daylight-saving due instants';
 IF current_setting('cron.launch_active_jobs')<>'off'
  OR (SELECT count(*) FROM cron.job_run_details)<>(SELECT n FROM timing_cron_runs_before) THEN
  RAISE EXCEPTION 'FAIL: catalog qualification launched a fixture job';END IF;
 RAISE NOTICE 'PASS: disabled real launcher records no fabricated execution proof';
END $actual_cron_assertions$;
