-- A CRON JOB THAT VANISHES IS NOT INVISIBLE.
--
-- Found while root-causing the 19 open bomb_award_ledger_gap criticals.
--
-- WHAT THE INCIDENTS ACTUALLY WERE. 25,888 bomb-pot hands were dealt in seven
-- days. Exactly 18 of them have NO rows at all in bomb_pot_award_units - not a
-- wrong split, not a partial write, nothing - and those 18 are precisely the 18
-- gaps the detector reports. The hand settled, the pot was paid, rake and BBJ
-- were taken; only the record of WHICH board and WHICH player got which share
-- was never written.
--
-- That write is fire-and-forget by design, and says so in its own comment:
-- three attempts with exponential backoff, reported on the third failure,
-- never allowed to fail the hand. That is the right trade for a hand in
-- progress. It is only safe if something afterwards repairs what was lost.
--
-- SOMETHING WAS SUPPOSED TO. Migration 20260831112020 scheduled
-- `bomb-multi-winner-repair-hourly` at '20 * * * *', and it is recorded as
-- APPLIED in supabase_migrations.schema_migrations. There are 124 active jobs
-- in cron.job right now and not one of them matches '%bomb%'. The job is gone.
-- fn_backfill_bomb_pot_award_units and fn_backfill_bomb_multi_winner_units both
-- still exist, ready, and nothing has called them for days.
--
-- SO THE REAL DEFECT IS NOT THE BOMB POT. It is that the estate cannot tell the
-- difference between a repair job that is running and a repair job that has
-- disappeared. Every cron check here measures jobs that RUN AND FAIL:
-- fn_ca_cron_failure_watch, fn_ca_cron_health, fn_cron_fleet_health,
-- fn_cron_fleet_silence, ops.cron_health. A job that no longer exists cannot
-- fail, produces no rows, and is therefore perfectly healthy by every one of
-- them. This is the same shape CLAUDE.md warns about twice - a guard that reads
-- as armed while being unreachable, and a metric reaching zero because the
-- thing stopped rather than because it succeeded.
--
-- THE FIX. Expected jobs become data. A roster row says the job should exist,
-- what it is for, and which migration put it there. fn_ca_cron_roster_watch
-- compares the roster against cron.job every hour and files a critical for
-- anything missing or deactivated. Adding a job without a roster row is
-- allowed; losing one silently is not.
--
-- The roster is seeded from the 124 jobs that exist today plus the one that
-- should, so the very first run has exactly one finding: the bomb repair.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ca_expected_cron_jobs (
  jobname          text PRIMARY KEY,
  expected_schedule text,
  purpose          text NOT NULL,
  declared_by      text NOT NULL,
  money_critical   boolean NOT NULL DEFAULT false,
  declared_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ca_expected_cron_jobs IS
  'The jobs that MUST exist in cron.job. Checked hourly by fn_ca_cron_roster_watch. '
  'A job that disappears cannot fail, so no failure-based check can see it - this '
  'table is what makes absence observable. Added 2026-09-06 after '
  'bomb-multi-winner-repair-hourly vanished from an applied migration and 18 bomb '
  'pots went four days with no award-unit record and no repair.';

CREATE OR REPLACE FUNCTION public.fn_ca_cron_roster_watch()
RETURNS TABLE (jobname text, state text, purpose text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT e.jobname, e.purpose, e.money_critical, e.declared_by, e.expected_schedule,
           j.jobid, COALESCE(j.active, false) AS active
      FROM public.ca_expected_cron_jobs e
      LEFT JOIN cron.job j ON j.jobname = e.jobname
     WHERE j.jobid IS NULL OR NOT COALESCE(j.active, false)
  LOOP
    state   := CASE WHEN r.jobid IS NULL THEN 'MISSING' ELSE 'INACTIVE' END;
    jobname := r.jobname;
    purpose := r.purpose;
    PERFORM public.fn_ca_raise_drift_incident(
      p_source          => 'fn_ca_cron_roster_watch',
      p_classification  => 'unknown',
      p_severity        => CASE WHEN r.money_critical THEN 'critical' ELSE 'warning' END,
      p_dedupe_key      => 'cron-roster:' || r.jobname,
      p_discrepancy     => 0,
      p_layer           => 'reporting',
      p_suspected_cause => 'scheduled job ' || r.jobname || ' is ' || state
        || '. It was declared by ' || r.declared_by || ' (' || COALESCE(r.expected_schedule,'?')
        || ') for: ' || r.purpose || '. No failure-based cron check can see this, because a '
        || 'job that does not exist never fails - reschedule it, or delete its roster row '
        || 'and say why in the same migration.',
      p_metadata        => jsonb_build_object('jobname', r.jobname, 'state', state,
                             'declared_by', r.declared_by));
    RETURN NEXT;
  END LOOP;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_cron_roster_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_cron_roster_watch() TO service_role;

-- Seed: everything that exists today is expected to keep existing.
INSERT INTO public.ca_expected_cron_jobs (jobname, expected_schedule, purpose, declared_by, money_critical)
SELECT j.jobname, j.schedule,
       'Present and active at roster seeding; purpose not yet stated - fill this in when you next touch the job.',
       'seed 20260906100405', false
  FROM cron.job j
 WHERE j.jobname IS NOT NULL
ON CONFLICT (jobname) DO NOTHING;

-- The one that should exist and does not.
INSERT INTO public.ca_expected_cron_jobs (jobname, expected_schedule, purpose, declared_by, money_critical)
VALUES (
  'bomb-multi-winner-repair-hourly', '20 * * * *',
  'Rebuilds bomb_pot_award_units for multi-winner bomb pots whose fire-and-forget '
  || 'write from settlement was lost. Without it a paid bomb pot keeps no record of '
  || 'which board and which player got which share.',
  'migration 20260831112020_schedule_bomb_multi_winner_repair', true)
ON CONFLICT (jobname) DO UPDATE
  SET money_critical = true, expected_schedule = EXCLUDED.expected_schedule,
      purpose = EXCLUDED.purpose, declared_by = EXCLUDED.declared_by;

-- Money-critical marks for the repair and reconciliation fleet: these are the
-- ones whose silence costs chips rather than tidiness.
UPDATE public.ca_expected_cron_jobs
   SET money_critical = true
 WHERE jobname IN ('ca-bbj-repair-unbanked-15m','ca-conservation-sweep-hourly',
                   'ca-escrow-ttl-sweep-10m','ca-payout-sweep-hourly',
                   'rake-repair-unbanked-hourly','spin_repair_missing_multiplier',
                   'spin_sweep_unbooked','tourney_payout_sweep_detect_daily',
                   'union-integrity-sweep');

-- Put the vanished job back.
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='bomb-multi-winner-repair-hourly') THEN
    PERFORM cron.unschedule('bomb-multi-winner-repair-hourly');
  END IF;
  PERFORM cron.schedule('bomb-multi-winner-repair-hourly', '20 * * * *',
    $job$SELECT public.fn_backfill_bomb_multi_winner_units(500, false);$job$);

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='bomb-award-units-repair-hourly') THEN
    PERFORM cron.unschedule('bomb-award-units-repair-hourly');
  END IF;
  /* The single-winner companion ran only from the ENGINE's hourly sweep, so it
     stopped whenever the engine did - including the shutdowns Phase 1 was
     about. DB-side it cannot drift from an engine build. */
  PERFORM cron.schedule('bomb-award-units-repair-hourly', '25 * * * *',
    $job$SELECT public.fn_backfill_bomb_pot_award_units(500, false);$job$);
END $sched$;

INSERT INTO public.ca_expected_cron_jobs (jobname, expected_schedule, purpose, declared_by, money_critical)
VALUES ('bomb-award-units-repair-hourly', '25 * * * *',
  'DB-side rebuild of single-winner bomb_pot_award_units. Previously engine-only, so '
  || 'it stopped whenever the engine stopped.',
  'migration 20260906100405_a_cron_job_that_vanishes_is_not_invisible', true)
ON CONFLICT (jobname) DO UPDATE SET money_critical = true;

-- Watch the roster hourly, and register the watch in its own roster.
DO $watch$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='ca-cron-roster-watch-hourly') THEN
    PERFORM cron.unschedule('ca-cron-roster-watch-hourly');
  END IF;
  PERFORM cron.schedule('ca-cron-roster-watch-hourly', '40 * * * *',
    $job$SELECT public.fn_ca_cron_roster_watch();$job$);
END $watch$;

INSERT INTO public.ca_expected_cron_jobs (jobname, expected_schedule, purpose, declared_by, money_critical)
VALUES ('ca-cron-roster-watch-hourly', '40 * * * *',
  'Compares ca_expected_cron_jobs against cron.job and files a critical for anything '
  || 'missing or deactivated. It watches itself: its own row is in the roster, so if '
  || 'this job is what disappears, the next run of any other roster check still names it.',
  'migration 20260906100405_a_cron_job_that_vanishes_is_not_invisible', true)
ON CONFLICT (jobname) DO UPDATE SET money_critical = true;

-- Repair what was lost, now, rather than waiting for :20.
DO $repair$
DECLARE v_multi int; v_single int; v_left int;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.hand_history h
   WHERE h.bomb_pot IS NOT NULL
     AND h.created_at > now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM public.bomb_pot_award_units a WHERE a.hand_history_id = h.id);
  RAISE NOTICE 'BOMB_GAPS_BEFORE %', v_left;

  BEGIN
    SELECT count(*) INTO v_single FROM public.fn_backfill_bomb_pot_award_units(500, false);
  EXCEPTION WHEN OTHERS THEN v_single := -1; RAISE NOTICE 'single backfill: %', SQLERRM;
  END;
  BEGIN
    SELECT count(*) INTO v_multi FROM public.fn_backfill_bomb_multi_winner_units(500, false);
  EXCEPTION WHEN OTHERS THEN v_multi := -1; RAISE NOTICE 'multi backfill: %', SQLERRM;
  END;

  SELECT count(*) INTO v_left
    FROM public.hand_history h
   WHERE h.bomb_pot IS NOT NULL
     AND h.created_at > now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM public.bomb_pot_award_units a WHERE a.hand_history_id = h.id);
  RAISE NOTICE 'BOMB_REPAIR single=% multi=% gaps_after=%', v_single, v_multi, v_left;
END $repair$;

-- Assert the roster is real and the jobs are back.
DO $assert$
DECLARE v_n int; v_missing int;
BEGIN
  SELECT count(*) INTO v_n FROM public.ca_expected_cron_jobs;
  IF v_n < 100 THEN
    RAISE EXCEPTION 'roster seeded with only % rows - expected the whole fleet', v_n;
  END IF;
  SELECT count(*) INTO v_missing
    FROM public.ca_expected_cron_jobs e
    LEFT JOIN cron.job j ON j.jobname = e.jobname
   WHERE j.jobid IS NULL;
  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'the roster still names % job(s) that do not exist', v_missing;
  END IF;
  RAISE NOTICE 'CRON_ROSTER rows=% missing=%', v_n, v_missing;
END $assert$;

COMMIT;
