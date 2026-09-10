-- the_retired_sweeps_keep_their_disabled_schedule_rows
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A correction to my own migration 20260910072322
-- (the_knockout_door_owns_every_bust_a_hand_took), made the moment it was
-- found, because it would have broken somebody else's unapplied work.
--
-- That migration called cron.unschedule on the two bust sweeps, which DELETES
-- their cron.job rows. `20260910000850_tournament_mutation_jobs_are_disabled_
-- before_retirement` - on origin/main since 00:08 today, part of the staged
-- seat-authority retirement chain, and NOT yet applied to production - opens
-- by capturing those rows into
-- `tournament_mutator_scheduler_retirement_receipts`, whose CHECK constraints
-- demand exactly two:
--
--     job_ids bigint[] NOT NULL CHECK (cardinality(job_ids)=2 ...)
--     jobs    jsonb    NOT NULL CHECK (... jsonb_array_length(jobs)=2)
--
-- With the rows gone that INSERT aborts, so the chain could never be applied
-- again. Deleting a row another migration is written to find is not a smaller
-- change than disabling it; it is a different one.
--
-- So the two rows come back with their original name, schedule and command,
-- and are set INACTIVE - which is precisely the state 20260910000850 puts them
-- in itself (cron.alter_job(active=>false)), so applying that chain later
-- finds what it expects and its own assertions pass unchanged.
--
-- An inactive row never fires, and it is not the only thing stopping this:
-- both functions now refuse any player whose latest knockout candidate is not
-- `rebought` (20260910072322), and the constraint trigger
-- tournament_elimination_has_a_place (20260910072351) refuses an eliminated
-- row with no finishing place in a live event whoever writes it. Re-enabling
-- the schedule by hand cannot bring the loop back.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_absent bigint;
  v_broke bigint;
  v_rows integer;
  v_active integer;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job
              WHERE command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
                 OR command ILIKE '%fn_ca_release_broke_seats%') THEN
    RAISE EXCEPTION 'a sweep schedule row already exists; 20260910072322 removed both and this migration puts exactly those two back';
  END IF;

  -- the original rows, verbatim: jobid 362, '*/15 * * * *',
  -- SELECT public.fn_ca_eliminate_absent_tournament_players(10, 500, false)
  -- and jobid 363, '*/15 * * * *',
  -- SELECT public.fn_ca_release_broke_seats(15, 200, false)
  SELECT cron.schedule('ca-eliminate-absent-players', '*/15 * * * *',
                       'SELECT public.fn_ca_eliminate_absent_tournament_players(10, 500, false)')
    INTO v_absent;
  SELECT cron.schedule('ca-release-broke-seats', '*/15 * * * *',
                       'SELECT public.fn_ca_release_broke_seats(15, 200, false)')
    INTO v_broke;

  PERFORM cron.alter_job(job_id => v_absent, active => false);
  PERFORM cron.alter_job(job_id => v_broke, active => false);

  SELECT count(*), count(*) FILTER (WHERE j.active)
    INTO v_rows, v_active
    FROM cron.job j
   WHERE j.jobname IN ('ca-eliminate-absent-players', 'ca-release-broke-seats');
  IF v_rows <> 2 OR v_active <> 0 THEN
    RAISE EXCEPTION 'expected two inactive sweep rows, found % row(s) of which % active', v_rows, v_active;
  END IF;
END
$body$;

COMMIT;
