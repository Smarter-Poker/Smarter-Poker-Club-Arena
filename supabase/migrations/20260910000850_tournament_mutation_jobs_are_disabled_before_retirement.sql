-- 20260910000850_tournament_mutation_jobs_are_disabled_before_retirement.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Commit the scheduler fence before the final retirement migration. This
-- guarantees pg_cron can no longer launch a mutation body while the later
-- migration proves no old run remains, unschedules the disabled jobs, drains
-- relation writers and drops the retired surface.

-- Phase A is a committed scheduler fence. Replacing a PL/pgSQL definition does
-- not stop an invocation that already entered the old body, so capture the
-- exact scheduled job IDs in a durable receipt before disabling them. Once
-- this transaction commits, pg_cron sees the retained rows as inactive and a
-- direct call can reach only the fail-closed body below. Retaining the rows
-- gives Phase B an exact job-ID join to run history while it proves no old-body
-- invocation remains, before it unschedules or drops the retired functions.
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SET LOCAL transaction_timeout = '90s';

SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
SELECT pg_advisory_xact_lock_shared(530090,1);
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:job:eliminate-absent-tournament-players:v1',0));
SELECT pg_advisory_xact_lock(
  hashtextextended('ca:job:release-broke-seats:v1',0));

DO $phase_a_require_live_freeze$
DECLARE
  v_pristine boolean;
BEGIN
  IF to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL THEN
    RAISE EXCEPTION 'scheduler fence requires the maintenance entry freeze authority'
      USING ERRCODE='55000';
  END IF;
  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
  ) INTO v_pristine;
  IF NOT v_pristine
     AND public.fn_entry_purchases_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION 'scheduler fence requires the maintenance entry freeze'
      USING ERRCODE='55006';
  END IF;
END;
$phase_a_require_live_freeze$;

CREATE TABLE public.tournament_mutator_scheduler_retirement_receipts (
  migration_version text PRIMARY KEY
    CHECK (migration_version='20260910000850'),
  captured_at timestamptz NOT NULL,
  job_ids bigint[] NOT NULL
    CHECK (cardinality(job_ids)=2 AND array_position(job_ids,NULL) IS NULL),
  jobs jsonb NOT NULL
    CHECK (jsonb_typeof(jobs)='array' AND jsonb_array_length(jobs)=2)
);

ALTER TABLE public.tournament_mutator_scheduler_retirement_receipts
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public.tournament_mutator_scheduler_retirement_receipts
  FROM PUBLIC,anon,authenticated,service_role;

INSERT INTO public.tournament_mutator_scheduler_retirement_receipts(
  migration_version,captured_at,job_ids,jobs)
SELECT
  '20260910000850',
  clock_timestamp(),
  COALESCE(
    array_agg(j.jobid ORDER BY j.jobid)
      FILTER (WHERE j.jobid IS NOT NULL),
    '{}'::bigint[]),
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'jobid',j.jobid,
        'jobname',j.jobname,
        'command',j.command,
        'schedule',j.schedule,
        'database',j.database,
        'username',j.username,
        'nodename',j.nodename,
        'nodeport',j.nodeport,
        'active',j.active)
      ORDER BY j.jobid)
      FILTER (WHERE j.jobid IS NOT NULL),
    '[]'::jsonb)
FROM cron.job j
WHERE j.jobname IN (
        'ca-eliminate-absent-players','ca-release-broke-seats')
   OR j.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
   OR j.command ILIKE '%fn_ca_release_broke_seats%';

CREATE OR REPLACE FUNCTION public.fn_ca_eliminate_absent_tournament_players(
  p_min_absent_minutes integer DEFAULT 10,
  p_limit integer DEFAULT 500,
  p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $retired_absent_player_mutator_fence$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:job:eliminate-absent-tournament-players:v1',0));
  RAISE EXCEPTION 'absent-player mutation job is retired'
    USING ERRCODE='55000';
END;
$retired_absent_player_mutator_fence$;

CREATE OR REPLACE FUNCTION public.fn_ca_release_broke_seats(
  p_min_dwell_minutes integer DEFAULT 15,
  p_limit integer DEFAULT 200,
  p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $retired_broke_seat_mutator_fence$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:job:release-broke-seats:v1',0));
  RAISE EXCEPTION 'broke-seat mutation job is retired'
    USING ERRCODE='55000';
END;
$retired_broke_seat_mutator_fence$;

REVOKE ALL ON FUNCTION public.fn_ca_eliminate_absent_tournament_players(
  integer,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_release_broke_seats(
  integer,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;

DO $commit_retired_tournament_mutator_schedule_fence$
DECLARE
  r record;
  v_job_ids bigint[];
BEGIN
  SELECT x.job_ids INTO STRICT v_job_ids
    FROM public.tournament_mutator_scheduler_retirement_receipts x
   WHERE x.migration_version='20260910000850';

  IF cardinality(v_job_ids)<>2 THEN
    RAISE EXCEPTION
      'scheduler fence expected exactly two tournament mutator jobs, found %',
      cardinality(v_job_ids)
      USING ERRCODE='55000';
  END IF;

  FOR r IN
    SELECT j.jobid FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids)
     ORDER BY j.jobid
  LOOP
    PERFORM cron.alter_job(job_id=>r.jobid,active=>false);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM cron.job j
     WHERE j.jobid=ANY(v_job_ids)
       AND j.active)
     OR (SELECT count(*) FROM cron.job j
          WHERE j.jobid=ANY(v_job_ids))<>2
     OR EXISTS (
       SELECT 1 FROM cron.job j
        WHERE (j.jobname IN (
                 'ca-eliminate-absent-players','ca-release-broke-seats')
            OR j.command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
            OR j.command ILIKE '%fn_ca_release_broke_seats%')
          AND (j.jobid<>ALL(v_job_ids) OR j.active)) THEN
    RAISE EXCEPTION
      'retired tournament mutation jobs were not retained exactly once and disabled';
  END IF;
END;
$commit_retired_tournament_mutator_schedule_fence$;

DO $phase_a_freeze_still_held$
DECLARE
  v_pristine boolean;
BEGIN
  SELECT NOT (
       EXISTS (SELECT 1 FROM auth.users)
    OR EXISTS (SELECT 1 FROM public.clubs)
    OR EXISTS (SELECT 1 FROM public.tournaments)
    OR EXISTS (SELECT 1 FROM public.tables)
    OR EXISTS (SELECT 1 FROM public.chip_ledger)
  ) INTO v_pristine;
  IF NOT v_pristine
     AND public.fn_entry_purchases_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION 'maintenance entry freeze expired before scheduler fence commit'
      USING ERRCODE='55006';
  END IF;
END;
$phase_a_freeze_still_held$;

COMMIT;
