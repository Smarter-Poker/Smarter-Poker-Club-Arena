\set ON_ERROR_STOP on
-- UNRUN. Isolated transition unit only. Apply captured-cron-prerequisites.sql
-- to a fresh cluster with the actual launcher disabled, then this file in one
-- psql session. Full atomic bundle acceptance/late-failure rollback is separate.
DO $$BEGIN
 IF current_setting('cron.launch_active_jobs',true) IS DISTINCT FROM 'off'
  OR current_setting('cron.database_name',true) IS DISTINCT FROM current_database()
  OR EXISTS(SELECT 1 FROM cron.job_run_details) THEN
  RAISE EXCEPTION 'captured cron transition fixture requires an unused disabled launcher';END IF;
END$$;
SELECT cron.schedule('fixture-captured-timing-unrelated','17 * * * *','SELECT 1');
CREATE TEMP TABLE captured_transition_before AS
 SELECT jsonb_agg(to_jsonb(j) ORDER BY j.jobid) AS jobs,
  coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.jobid) FILTER(WHERE j.jobid NOT IN(271,272)),'[]'::jsonb) AS others
 FROM cron.job j;
\ir ../../../supabase/accounting/weekly-v3/components/20260914155450_captured_cron_enters_the_sealed_accounting_transition.sql
DO $transition_assertions$
DECLARE expected_command text:=$close$
  SET statement_timeout = '2400s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','2400s',true) is not null
                      and public.fn_union_settlement_cascade_due() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $close$;
 expected_jobs jsonb;
BEGIN
 SELECT jsonb_agg(CASE WHEN (j->>'jobid')::bigint=272 THEN
    jsonb_set(jsonb_set(j,'{schedule}',to_jsonb('5,35 * * * *'::text)),'{command}',to_jsonb(expected_command))
    ELSE j END ORDER BY (j->>'jobid')::bigint)
  INTO expected_jobs FROM captured_transition_before b CROSS JOIN LATERAL jsonb_array_elements(b.jobs)j;
 IF (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.jobid) FROM cron.job j) IS DISTINCT FROM expected_jobs THEN
  RAISE EXCEPTION 'FAIL: captured job identities and exact intermediate transition differ';END IF;
 RAISE NOTICE 'PASS: actual captured job272 enters the sealed command/schedule contract without replacing either job';
 IF (SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.jobid),'[]'::jsonb) FROM cron.job j WHERE j.jobid NOT IN(271,272))
    IS DISTINCT FROM (SELECT others FROM captured_transition_before) THEN
  RAISE EXCEPTION 'FAIL: captured transition changed an unrelated actual job';END IF;
 RAISE NOTICE 'PASS: unrelated actual extension jobs remain byte-equivalent';
 IF current_setting('cron.launch_active_jobs') IS DISTINCT FROM 'off' OR EXISTS(SELECT 1 FROM cron.job_run_details) THEN
  RAISE EXCEPTION 'FAIL: captured transition fixture launched a job';END IF;
 RAISE NOTICE 'PASS: actual launcher stayed disabled throughout the isolated transition';
END $transition_assertions$;
