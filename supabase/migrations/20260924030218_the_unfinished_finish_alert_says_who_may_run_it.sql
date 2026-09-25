-- the_unfinished_finish_alert_says_who_may_run_it
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS MISSING
--
-- 20260922160729_an_unfinished_finish_is_alerted_per_tournament redefined
-- public.fn_ca_tournament_finished_but_not_completed(integer) to dedupe its
-- alert per stuck tournament instead of per source. It did not restate who
-- may execute it, and scripts/ci/check-definer-authorization.mjs reads the
-- MIGRATION, not the live catalogue. A SECURITY DEFINER function that writes
-- and does not consult auth.uid() has to close the browser roles in the same
-- file it is declared in, or the gate cannot tell a closed door from an
-- unexamined one. It refused the push, correctly.
--
-- Production was never open. Measured 2026-09-24 03:0x UTC, before this ran:
--
--   acl                                {postgres=X/postgres,service_role=X/postgres}
--   has_function_privilege anon         false
--   has_function_privilege authenticated false
--   has_function_privilege service_role  true
--
-- So this changes nothing about who can call it. It states, in a migration,
-- what is already true, which is what the gate is asking for. The statements
-- are idempotent and safe to re-run.
--
-- NOBODY IN A BROWSER SHOULD CALL IT. It is an observer: pg_cron runs it every
-- five minutes as ca-tournament-finished-not-completed-5m, it raises a
-- financial_alerts row when a tournament has finished play without completing,
-- and it completes nothing itself. There is no caller in this repository's
-- src/ or server/, and none in the World Hub.
--
-- @live-proof: (SELECT NOT has_function_privilege('anon', 'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE'))
-- @live-proof: (SELECT NOT has_function_privilege('authenticated', 'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE'))
-- @live-proof: (SELECT has_function_privilege('service_role', 'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE'))
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- PUBLIC is named as well as the roles. Revoking a role while PUBLIC still
-- holds the grant reads as a fix and does nothing: has_function_privilege
-- answers true through PUBLIC.
REVOKE ALL ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_finished_but_not_completed(integer)
  TO service_role;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: anon can still execute the unfinished-finish observer';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: authenticated can still execute the unfinished-finish observer';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_ca_tournament_finished_but_not_completed(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: service_role can no longer execute it, so the cron job would stop';
  END IF;
  RAISE NOTICE 'PASS: the unfinished-finish observer is service_role only';
END
$verify$;

COMMIT;
