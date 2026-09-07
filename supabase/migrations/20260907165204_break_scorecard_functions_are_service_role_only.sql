-- 20260907165204_break_scorecard_functions_are_service_role_only.sql
--
-- THE RECORD OF A GRANT CHANGE THAT WAS APPLIED SEPARATELY.
--
-- `check-definer-authorization` blocked the push of
-- 20260907163100_the_break_scorecard_measures_the_break_that_actually_ran.sql
-- and was right to. Both functions it redefines are SECURITY DEFINER WRITERS
-- that a browser role could execute and that never ask who is calling:
--
--   fn_ca_record_break_scorecard  writes a row to ca_break_scorecards
--   fn_ca_break_scorecard_push    inserts a notification for every recipient
--
-- Neither should ever be reachable from a browser. There is no per-player
-- version of "grade the maintenance break": the recorder is an hourly pg_cron
-- job and the push is its own helper. Before this, an anon session could have
-- written an arbitrary scorecard row and pushed a notification to Dan's phone.
--
-- These statements are ALSO carried inside the 163100 migration, which is the
-- one that redefines the functions and therefore the one that must not leave
-- them open. This file exists because the grants were applied to production as
-- their own migration version while that one was being fixed, and
-- `check-applied-migrations-are-recorded.mjs` matches on version OR name — so
-- an applied version with neither is drift, whatever else in the repo happens
-- to contain the same SQL. A migration production has run gets a file.
--
-- Idempotent: REVOKE of a privilege already revoked and GRANT of one already
-- held are both no-ops, so applying this twice changes nothing.
--
-- PUBLIC is named as well as the roles. Revoking `anon` and `authenticated`
-- while PUBLIC still holds EXECUTE reads as a fix and does nothing, because
-- both inherit it from PUBLIC.
--
-- pg_cron is unaffected: its jobs run as the job owner, which is the superuser
-- that owns these functions, and the recorder reaches the push through PERFORM
-- inside its own definer context.
--
-- GRANT/REVOKE are not in pgrst_ddl_watch's list, so nothing here costs a
-- schema-cache reload (club-arena CLAUDE.md, production DDL policy, rule 5).

BEGIN;

REVOKE ALL ON FUNCTION public.fn_ca_record_break_scorecard(timestamp with time zone)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_record_break_scorecard(timestamp with time zone)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_break_scorecard_push(public.ca_break_scorecards)
  TO service_role;

COMMIT;
