-- ===========================================================================
--  THE DIAMOND CASH RAKE IS SWEPT TO THE HOUSE EVERY HOUR
-- ===========================================================================
--
-- 20261007034146_the_diamond_cash_rake_is_swept_to_the_house_every_hour.sql.
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch.
--
-- WHY. A raked Diamond cash hand does not pay the house when it settles.
-- fn_poker_diamond_settle_cash_hand moves the rake from the payers' custody
-- into public.ca_diamond_rake_accrual, which fn_ca_arena_diamonds() counts in
-- the arena float (design R4 and R5, docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md;
-- built by 20261005151712 and 20261005183028). The rake reaches the house only
-- when public.fn_ca_diamond_sweep_cash_rake runs: it takes every unswept
-- accrual row oldest first, writes one spend row per payer, checks that the
-- register retired exactly that, banks the total to ca_diamond_house row 1
-- with one mint row, marks the rows swept and asserts the Diamond identity is
-- 0. Diamond cash reopened at 02:13 UTC on 2026-10-07 (20261006154844), and
-- nothing calls the sweep: no cron job, and no engine or client path. Without
-- a schedule, every Diamond of cash rake stays in the arena float and the
-- house never receives it.
--
-- periodic-work: design R4 says per-hand Diamond rake accrues player-side and crosses to the house "in a periodic sweep: one house write per sweep, not per hand", so that no Diamond cash hand ever waits on ca_diamond_house row 1. This job is that sweep, the designed second half of the rake path. The settler writes every accrual row correctly and completely; the sweep repairs, retries and back-pays nothing.
--
-- THE CADENCE IS A DECISION. No owner answer in ca_diamond_economics fixes
-- how often the sweep runs. Decided by Claude on Dan's delegation ("these are
-- all for you to decide not me", 2026-09-30; the economics table's standing
-- answer, "NOTHING IS MINE, EVER.... THEY ARE ALWAYS YOURS TO DO."): every
-- hour, at :14 UTC. Recorded as ruling 26 in docs/DIAMOND-RULINGS.md. Hourly
-- keeps platform-owned rake in the player-side float for under an hour (design
-- R1 parks nothing platform-owned there), keeps the house current for the
-- hourly Diamond snapshot (:10) and trial balance (:20), and costs the house
-- row one write an hour.
--
-- WHY :14. Read from cron.job and cron.job_run_details at 03:35 UTC on
-- 2026-10-07: no hourly job starts at :14, and its neighbours have finished
-- by then (:12 tourney_money_conservation_hourly, longest run in 24 hours
-- 34 s; :13 sp_prune_hand_history_10m, longest 40 s). It is far outside the
-- :50-:03 break window (CLAUDE.md section 13).
--
-- HOW IT RUNS, the way this estate's hourly jobs run:
--   - SET statement_timeout = '60s' as its own first statement, which is where
--     a pg_cron command's budget takes effect (20261003025058). Measured on
--     production: the identity read takes 85 ms and the supply sum 45 ms, so a
--     sweep of an hour's rows needs well under a second.
--   - pg_try_advisory_lock on the job's own name, so two runs never overlap.
--   - fn_platform_frozen() before any Diamond moves. CLAUDE.md section 13,
--     invariant 5: a new periodic sweep that moves money gets the freeze gate
--     in the same change, and the Diamond tables carry no freeze trigger. A
--     skipped hour loses nothing: its rows stay unswept, still counted in the
--     arena float, and the next run takes them oldest first.
--
-- WHAT THIS FILE DOES. Checks that the sweep exists and that the owner's
-- destination is the house; removes any job of the same name, so the file can
-- run twice; schedules the job; and proves it: the job is there once, active,
-- with exactly this schedule and command; both arena switches read what they
-- read before this file ran (it never writes them:
-- tests/only-a-person-moves-the-arena-switches.law.test.ts); and the Diamond
-- identity is 0. It defines no function, table or trigger, so it sends no DDL
-- and no PostgREST reload. It does not call the sweep: the first sweep is the
-- job's own first run.
--
-- @live-proof: (SELECT count(*) = 1 FROM cron.job WHERE jobname = 'ca-diamond-cash-rake-sweep-hourly' AND active AND schedule = '14 * * * *')
-- @live-proof: (SELECT bool_and(position('public.fn_platform_frozen()' IN command) > 0 AND position('public.fn_ca_diamond_sweep_cash_rake(' IN command) > 0) FROM cron.job WHERE jobname = 'ca-diamond-cash-rake-sweep-hourly')
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. PRECONDITIONS, AND THE SWITCHES AS THIS TRANSACTION FOUND THEM.
DO $pre$
BEGIN
  IF to_regprocedure('public.fn_ca_diamond_sweep_cash_rake(text)') IS NULL THEN
    RAISE EXCEPTION 'the Diamond cash rake sweep is not scheduled: public.fn_ca_diamond_sweep_cash_rake(text) does not exist';
  END IF;
  IF public.fn_ca_diamond_economic_text('cash_rake_destination', 'all') IS DISTINCT FROM 'ca_diamond_house' THEN
    RAISE EXCEPTION 'the Diamond cash rake sweep is not scheduled: cash_rake_destination reads %, and ruling 26 sweeps to ca_diamond_house',
      public.fn_ca_diamond_economic_text('cash_rake_destination', 'all');
  END IF;
  -- Kept for this transaction only, so the last block can prove this file
  -- moved neither switch.
  PERFORM set_config('ca.rake_sweep_schedule_switches',
    COALESCE((SELECT cash_games_enabled::text || '/' || tournaments_enabled::text
                FROM public.ca_arena_settings WHERE id = 1), 'missing'),
    true);
END
$pre$;

-- 2. A job of this name from an earlier run of this file goes first.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ca-diamond-cash-rake-sweep-hourly';

-- 3. THE SCHEDULE.
SELECT cron.schedule(
  'ca-diamond-cash-rake-sweep-hourly',
  '14 * * * *',
  $cron$SET statement_timeout = '60s'; DO $job$ BEGIN IF NOT pg_try_advisory_lock(hashtext('ca-diamond-cash-rake-sweep-hourly')) THEN RAISE NOTICE 'skipped: previous run still in progress'; ELSIF public.fn_platform_frozen() THEN RAISE NOTICE 'skipped: the platform is frozen for a maintenance break'; ELSE PERFORM public.fn_ca_diamond_sweep_cash_rake('hourly sweep: ca-diamond-cash-rake-sweep-hourly'); END IF; END $job$;$cron$
);

-- 4. PROOF: the job, the switches and the Diamond identity.
DO $proof$
DECLARE
  c_command constant text := $cron$SET statement_timeout = '60s'; DO $job$ BEGIN IF NOT pg_try_advisory_lock(hashtext('ca-diamond-cash-rake-sweep-hourly')) THEN RAISE NOTICE 'skipped: previous run still in progress'; ELSIF public.fn_platform_frozen() THEN RAISE NOTICE 'skipped: the platform is frozen for a maintenance break'; ELSE PERFORM public.fn_ca_diamond_sweep_cash_rake('hourly sweep: ca-diamond-cash-rake-sweep-hourly'); END IF; END $job$;$cron$;
  v_jobs   integer;
  v_before text := current_setting('ca.rake_sweep_schedule_switches', true);
  v_after  text;
  v_diff   numeric;
BEGIN
  SELECT count(*) INTO v_jobs FROM cron.job WHERE jobname = 'ca-diamond-cash-rake-sweep-hourly';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'ca-diamond-cash-rake-sweep-hourly is in cron.job % times, expected exactly once', v_jobs;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'ca-diamond-cash-rake-sweep-hourly'
                    AND active AND schedule = '14 * * * *' AND command = c_command) THEN
    RAISE EXCEPTION 'ca-diamond-cash-rake-sweep-hourly is not active at 14 * * * * with exactly the command this file scheduled';
  END IF;

  v_after := COALESCE((SELECT cash_games_enabled::text || '/' || tournaments_enabled::text
                         FROM public.ca_arena_settings WHERE id = 1), 'missing');
  IF v_before IS NULL OR v_before = 'missing' OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'the arena switches moved or could not be read: before %, after %', v_before, v_after;
  END IF;

  SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
  IF v_diff IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole (difference %)', v_diff;
  END IF;

  RAISE NOTICE 'ca-diamond-cash-rake-sweep-hourly runs at 14 * * * *; arena switches % unchanged; Diamond identity 0', v_after;
END
$proof$;

COMMIT;
