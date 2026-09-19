-- 20260919172421_one_row_of_cron_health_must_describe_one_run
--
-- Applied to production as version 20260919172244 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- fn_ca_cron_health() returned one row per job built from TWO DIFFERENT RUNS:
--
--   max(r.start_time)                                     as last_run_at
--   left(max(r.return_message) filter (...failed...),200) as last_error
--
-- last_run_at is the most recent run of any status. last_error is the
-- LEXICOGRAPHICALLY GREATEST failure message anywhere in the window, because
-- max() on text sorts text. It is not the most recent failure and it has no
-- relationship to the run named beside it.
--
-- Measured consequence on 2026-09-19. Three jobs had been fixed earlier the
-- same day and had already succeeded:
--
--   tourney_money_conservation_hourly       16:12 succeeded in 4.2s
--   ca-pay-backed-payout-shortfalls-hourly  16:26 succeeded in 55.6s
--   rake-law-adherence-hourly               15:40 and 16:40 succeeded
--
-- All three still displayed a statement-timeout error from runs at or before
-- 15:52, pinned next to a current last_run_at. ca-conservation-sweep-hourly
-- displayed a timeout while its five most recent runs all succeeded, taking
-- 47s to 103s. A reader who trusts the column names concludes the estate is
-- broken and re-diagnoses work that is already done. That happened, to the
-- agent writing this migration, before cron.job_run_details was consulted
-- directly and the reading was withdrawn.
--
-- This is the same defect class as the index predicate in 20260919154718: a
-- value kept beside the fact it is supposed to describe, free to drift from
-- it. The cure is the same. Do not keep the copy in step. Remove the coupling
-- so there is nothing to keep in step.
--
-- ===========================================================================
-- THE BAND-AID THAT WAS REFUSED
--
-- The one-character fix is to sort the failures by time instead of by text:
--
--   (array_agg(r.return_message ORDER BY r.start_time DESC))[1]
--
-- It makes last_error the most RECENT failure, which is better, and it is
-- still wrong in the way that caused the misreading. A job that failed at
-- 12:12 and has succeeded every hour since would still print a red error
-- string beside a green run. The column would still be answering a question
-- nobody asked. The defect is not which failure is chosen. The defect is that
-- a row describes two runs at once.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- One row now describes ONE run. last_run_status, last_error and last_error_at
-- are all taken from the single most recent FINISHED run, by DISTINCT ON over
-- that job's runs. A job whose last finished run succeeded reports
-- last_error IS NULL, because it does not currently have an error. Its
-- failures count still reports that it failed earlier in the window, which is
-- what that column is for.
--
-- Verdict logic is UNCHANGED and deliberately so: critical still means ran and
-- never once succeeded over the whole window, which is a window property, not
-- a last-run property. Only the evidence columns are corrected.
--
-- Column names and types that existed before are preserved. Two columns are
-- added. scripts/ci/check-cron-health.mjs reads this over PostgREST as JSON
-- and touches only verdict, jobname, schedule, runs, failures and last_error,
-- null-guarding last_error before printing it, so added keys are inert to it
-- and a null is already handled.
--
-- DROP and CREATE is required because RETURNS TABLE gains columns. The prior
-- ACL was postgres=X/postgres and service_role=X/postgres; a DROP discards
-- grants, so service_role EXECUTE is restored explicitly below and nothing is
-- granted to anon or authenticated. It reads cron internals as SECURITY
-- DEFINER and no browser role has ever been able to call it.
--
-- THE REVOKE MUST NAME THE ROLES, NOT ONLY PUBLIC. This project carries
-- ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions in schema public
-- to anon, authenticated and service_role. Those land as EXPLICIT role grants
-- on the recreated function, so revoking PUBLIC alone leaves them in place.
-- The first apply of this migration did exactly that and handed anon EXECUTE
-- on a SECURITY DEFINER reader of cron internals; the pre-push hook
-- check-definer-authorization refused the push and named it. Production was
-- corrected by 20260919173340; this file carries the correct form so a fresh
-- rebuild never opens the door in the first place.
--
-- MEASURED AFTER APPLYING: criticals fell from 5 to 3, and all three remaining
-- report last_run_status = 'failed' with their own error. The other two were
-- reporting an error from a run that was not their last one. Nine warn-level
-- jobs that had recovered now report last_error IS NULL.
--
-- @live-proof: (SELECT position('last_run_status' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_cron_health')
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS public.fn_ca_cron_health(interval);

CREATE FUNCTION public.fn_ca_cron_health(p_window interval DEFAULT '24:00:00'::interval)
RETURNS TABLE(
  jobname         text,
  schedule        text,
  verdict         text,
  runs            bigint,
  failures        bigint,
  successes       bigint,
  last_run_at     timestamp with time zone,
  last_error      text,
  last_run_status text,
  last_error_at   timestamp with time zone
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  with j as (
    select jobid, jobname, schedule from cron.job where active
  ),
  w as (
    select r.jobid, r.status, r.return_message, r.start_time
      from cron.job_run_details r
     where r.start_time > now() - p_window
  ),
  agg as (
    select j.jobid, j.jobname, j.schedule,
           count(w.*)                                     as runs,
           count(*) filter (where w.status = 'failed')    as failures,
           count(*) filter (where w.status = 'succeeded') as successes,
           max(w.start_time)                              as last_run_at
      from j left join w on w.jobid = j.jobid
     group by j.jobid, j.jobname, j.schedule
  ),
  -- ONE run, whole. status and message cannot come from different runs
  -- because they are columns of the same row.
  last_finished as (
    select distinct on (w.jobid)
           w.jobid, w.status, w.return_message, w.start_time
      from w
     where w.status in ('succeeded', 'failed')
     order by w.jobid, w.start_time desc
  )
  select a.jobname, a.schedule,
         case
           -- Only FINISHED runs are evidence. pg_cron logs a row at START, so
           -- a job mid-flight has status 'running' and counts as neither.
           when a.failures + a.successes = 0 then 'idle'
           when a.successes = 0              then 'critical'
           when a.failures  > 0              then 'warn'
           else 'ok'
         end as verdict,
         a.runs, a.failures, a.successes, a.last_run_at,
         case when lf.status = 'failed'
              then left(lf.return_message, 200) end as last_error,
         lf.status                                  as last_run_status,
         case when lf.status = 'failed'
              then lf.start_time end                as last_error_at
    from agg a
    left join last_finished lf on lf.jobid = a.jobid
   order by
     case
       when a.failures + a.successes = 0 then 3
       when a.successes = 0              then 0
       when a.failures  > 0              then 1
       else 2
     end,
     a.failures desc,
     a.jobname;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_cron_health(interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_cron_health(interval) TO service_role;

COMMENT ON FUNCTION public.fn_ca_cron_health(interval) IS
  'Cron health, one row per active job. last_run_status, last_error and last_error_at all come from the SAME most recent finished run. They used to come from different runs: last_error was max() over failure text, which is the lexicographically greatest message in the window, not the most recent, and it was printed beside an unrelated last_run_at. Do not reintroduce an aggregate over return_message.';

DO $verify$
DECLARE
  v_bad        integer;
  v_recovered  integer;
  v_still_red  integer;
BEGIN
  -- Structural: every row that reports an error must be a row whose own last
  -- run failed. This is the invariant the old shape could not hold.
  SELECT count(*) INTO v_bad
    FROM public.fn_ca_cron_health('24 hours'::interval)
   WHERE last_error IS NOT NULL
     AND last_run_status IS DISTINCT FROM 'failed';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'failed: % row(s) report an error whose own last run did not fail', v_bad;
  END IF;

  -- Both directions (the 7.2 rule). A blanket "never report an error" would
  -- satisfy the assertion above, so the negative case must still fire.
  SELECT count(*) INTO v_recovered
    FROM public.fn_ca_cron_health('24 hours'::interval)
   WHERE failures > 0
     AND last_run_status = 'succeeded'
     AND last_error IS NULL;

  SELECT count(*) INTO v_still_red
    FROM public.fn_ca_cron_health('24 hours'::interval)
   WHERE last_run_status = 'failed'
     AND last_error IS NOT NULL
     AND last_error_at IS NOT NULL;

  IF v_recovered = 0 THEN
    RAISE EXCEPTION 'failed: no recovered job observed, so the positive direction is unproven';
  END IF;
  IF v_still_red = 0 THEN
    RAISE EXCEPTION 'failed: no genuinely failing job reports an error, so this may be reporting nothing at all';
  END IF;

  RAISE NOTICE 'cron health corrected: % recovered job(s) now report no error, % job(s) still failing report one', v_recovered, v_still_red;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
