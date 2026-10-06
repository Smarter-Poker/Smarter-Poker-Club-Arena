-- 20261003105926_a_close_attempt_stops_after_one_long_step.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CLOSE ATTEMPT STOPS AFTER ONE LONG STEP
--
-- Follows 20261003101805_the_weekly_close_commits_one_round_at_a_time. There a
-- chunked union close attempt kept each problem-free P&L step it proved and
-- stopped ('warming') once less than 6 minutes of its scope budget was left.
-- Measured on 2026-10-03 for the Midway week 2026-09-21..28 (one chunked close,
-- job 414; then each step re-proved fresh, jobs 415-417, every result
-- identical to the kept one): opening boundary 157 s and 275 s with the
-- closing one, closing boundary 76 s, original flows 93 s, touched
-- registrations 46 s, earned plan 193 s and 320 s, club rows ~50 s. The week
-- closing 2026-10-05 carries ~2.3x the sources, so the earned plan alone can
-- take 440-740 s. Under the 6-minutes-left rule one attempt runs the touched
-- registrations and then starts the earned plan, which can carry it past job
-- 272's 720 s statement timeout and lose both; and an attempt on job 272's
-- large fallback budget (50 minutes, after a statement timeout) would run
-- every remaining step in one transaction for up to 44 minutes.
--
-- WHAT CHANGES: fn_accounting_close_warm_stop also stops an attempt that has
-- proved and kept a step once 60 seconds have passed since the attempt began
-- (its deadline minus its scope budget, exactly as
-- fn_weekly_accounting_attempt_begin set it). Each attempt therefore proves
-- the short steps together and any long step alone, on the small and the large
-- budget alike, and the next attempt continues from the kept steps. Nothing
-- else changes; outside a chunked union close attempt the function is false as
-- before.
--
-- @live-proof: position('interval ''60 seconds''' in pg_get_functiondef('public.fn_accounting_close_warm_stop()'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE s regprocedure := 'public.fn_accounting_close_warm_stop()'::regprocedure; d text;
BEGIN
 d:=pg_get_functiondef(s);
 IF md5(d)<>'c155de2fa07f15a206a5b69fbc99da19' THEN RAISE EXCEPTION 'warm stop preimage %',md5(d); END IF;
END
$mig$;

CREATE OR REPLACE FUNCTION public.fn_accounting_close_warm_stop()
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'public'
AS $f$
 SELECT COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
    AND current_setting('app.accounting_close_certified',true)='on'
    AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL
    AND (clock_timestamp()>NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz-interval '6 minutes'
     OR clock_timestamp()>NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
        -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval
        +interval '60 seconds')
$f$;
REVOKE ALL ON FUNCTION public.fn_accounting_close_warm_stop() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_accounting_close_warm_stop() IS
  'Chunked weekly close (20261003): true when this attempt proved and kept a step and either 60 seconds have passed since it began or less than 6 minutes of its scope budget are left, so the P&L evidence report stops with status warming and the next attempt continues.';

DO $mig$
BEGIN
 IF position('interval ''60 seconds''' in pg_get_functiondef('public.fn_accounting_close_warm_stop()'::regprocedure))=0 THEN
  RAISE EXCEPTION 'warm stop postimage';
 END IF;
END
$mig$;

COMMIT;
