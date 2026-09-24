-- 20260924025037_the_incident_tick_that_repairs_nothing_stops_running
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-24 02:50:37 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- THE TWELFTH JOB, AND THE ONE THAT HAD TO WAIT
--
-- The migration immediately before this one retired eleven compensation jobs
-- whose writers were already correct at source. ca-auto-reconcile-tick could
-- not go with them, because on 2026-09-22 it was still doing something, and a
-- repair loop is only safe to retire once it is doing nothing. It ran every
-- minute, 1,440 times a day.
--
-- WHAT IT WAS ACTUALLY DOING, measured 2026-09-22 over the preceding 7 days:
--
--   rewriting auto_repair_status from 'pending' to 'manual_needed'   139
--   re-driving rake and BBJ for an open incident                   7,774
--   closing an incident it had re-verified clean                       0
--
-- The 7,774 re-drives moved nothing: pending_fee_distributions kind='rake'
-- has had no unresolved row since 2026-09-08 17:30, and the BBJ repair's own
-- marker (a bbj_contributions row with a null hand_number) has none after
-- 2026-09-08 17:17. 9,176 of those pairs were for a single RakeSpec.drift
-- incident that no re-drive could ever have touched.
--
-- So the only thing it really did was rewrite a column to the value it should
-- have been born with. That is not a repair; it is a default in the wrong
-- place. The column default came from 20260831142753 and said 'pending', so
-- every incident was born claiming an automatic repair was coming for it.
--
-- THE ROOT CAUSE IS FIXED. an_incident_is_born_with_the_repair_status_it_will
-- _get (recorded 20260922141732, applied 2026-09-22 14:17:32 UTC) changed the
-- default to 'manual_needed'. Both incident writers inherit it.
--
-- THE OBSERVATION WINDOW ASKED FOR 24 HOURS. It has now had 36. Measured
-- 2026-09-24 02:47 UTC:
--
--   incidents open/acknowledged/reconciling with auto_repair_status
--     pending or running                                               0
--   incidents born since the fix with any other status                 0
--   repair_action events since the fix                                 0
--     (its last action of any kind: 2026-09-22 14:04:02, before the fix)
--   unresolved rake outbox rows                                        0
--   BBJ repair marker rows since the fix                               0
--
-- WHAT THIS DOES NOT REMOVE. fn_ca_auto_reconcile_tick, fn_redrive_unbanked
-- _rake and fn_bbj_repair_unbanked all stay defined. This job was their last
-- scheduled caller, which the verification below asserts rather than assumes:
-- after this, nothing on a timer reaches them. Dropping dead functions is a
-- separate decision with its own review; leaving them costs nothing and keeps
-- this change to one thing.
--
-- WHAT IT COSTS. The tick also closed transient incidents ten minutes after
-- they cleared. It closed 0 in the last 14 days, and an incident that clears
-- itself is closed by the hourly ca-resolve-cleared-incidents job, which is an
-- observer and stays. Incidents now stay open for a person, which is what
-- 'manual_needed' has meant since 2026-09-22.
--
-- @live-proof: (SELECT count(*) FROM cron.job WHERE jobname = 'ca-auto-reconcile-tick') = 0
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $retire$
DECLARE
  v_active  bigint;
  v_total   bigint;
  v_owed    bigint;
  v_default text;
  v_jobid   bigint;
BEGIN
  -- (a) The roster this was measured against, after the eleven.
  SELECT count(*) FILTER (WHERE active), count(*) INTO v_active, v_total FROM cron.job;
  IF v_active IS DISTINCT FROM 122 OR v_total IS DISTINCT FROM 124 THEN
    RAISE EXCEPTION 'refused: cron.job holds % active of % rows; this expected 122 of 124, the state the eleven left. Re-measure, do not guess.',
      v_active, v_total;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-auto-reconcile-tick' AND active) THEN
    RAISE EXCEPTION 'refused: ca-auto-reconcile-tick is not scheduled; nothing to retire';
  END IF;

  -- (b) The root cause is fixed at source: an incident is born needing a
  --     person, so the tick has nothing left to rewrite.
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public.ca_drift_incidents'::regclass
     AND a.attname = 'auto_repair_status';
  IF v_default IS NULL OR position('manual_needed' in v_default) = 0 THEN
    RAISE EXCEPTION 'refused: ca_drift_incidents.auto_repair_status does not default to manual_needed (%); the defect this retires is back',
      coalesce(v_default, 'no default');
  END IF;

  -- (c) Nothing is owed that this job would have been the one to deliver.
  SELECT count(*) INTO v_owed FROM public.ca_drift_incidents
   WHERE status IN ('open', 'acknowledged', 'reconciling')
     AND auto_repair_status IN ('pending', 'running');
  IF v_owed > 0 THEN
    RAISE EXCEPTION 'refused: % incident(s) still claim an automatic repair is coming', v_owed;
  END IF;
  SELECT count(*) INTO v_owed FROM public.ca_drift_incidents
   WHERE created_at > timestamptz '2026-09-22 14:17:32+00'
     AND auto_repair_status <> 'manual_needed';
  IF v_owed > 0 THEN
    RAISE EXCEPTION 'refused: % incident(s) born since the fix carry another status; the default is not holding', v_owed;
  END IF;
  SELECT count(*) INTO v_owed FROM public.pending_fee_distributions
   WHERE resolved_at IS NULL AND kind = 'rake';
  IF v_owed > 0 THEN
    RAISE EXCEPTION 'refused: % unresolved rake outbox row(s); a re-drive still has work', v_owed;
  END IF;

  SELECT j.jobid INTO v_jobid FROM cron.job j WHERE j.jobname = 'ca-auto-reconcile-tick';
  PERFORM cron.unschedule(v_jobid);
  RAISE NOTICE 'retired ca-auto-reconcile-tick (jobid %)', v_jobid;
END;
$retire$;

DO $verify$
DECLARE
  v_active   bigint;
  v_total    bigint;
  v_inactive text;
  v_callers  text;
  v_missing  text;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-auto-reconcile-tick') THEN
    RAISE EXCEPTION 'failed: ca-auto-reconcile-tick is still scheduled';
  END IF;

  SELECT count(*) FILTER (WHERE active), count(*),
         coalesce(string_agg(jobname, ', ' ORDER BY jobname) FILTER (WHERE NOT active), '')
    INTO v_active, v_total, v_inactive
    FROM cron.job;
  IF v_active IS DISTINCT FROM 121 OR v_total IS DISTINCT FROM 123 THEN
    RAISE EXCEPTION 'failed: % active of % rows remain, expected 121 of 123', v_active, v_total;
  END IF;
  IF v_inactive IS DISTINCT FROM 'ca-eliminate-absent-players, ca-release-broke-seats' THEN
    RAISE EXCEPTION 'failed: the retained-inactive rows changed: %', v_inactive;
  END IF;

  -- The functions stay defined, and nothing on a timer reaches them now.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('fn_ca_auto_reconcile_tick',
                           'fn_redrive_unbanked_rake',
                           'fn_bbj_repair_unbanked')) <> 3 THEN
    RAISE EXCEPTION 'failed: a function this retirement keeps on purpose is gone';
  END IF;
  SELECT string_agg(j.jobname, ', ' ORDER BY j.jobname) INTO v_callers
    FROM cron.job j
   WHERE j.active
     AND (j.command ~ 'fn_ca_auto_reconcile_tick'
       OR j.command ~ 'fn_redrive_unbanked_rake'
       OR j.command ~ 'fn_bbj_repair_unbanked');
  IF v_callers IS NOT NULL THEN
    RAISE EXCEPTION 'failed: a scheduled job still reaches a retired repair path: %', v_callers;
  END IF;

  -- The two jobs still inside their observation windows are untouched.
  SELECT string_agg(k.jobname, ', ' ORDER BY k.jobname) INTO v_missing
    FROM unnest(ARRAY['reconcile-tournament-denormals',
                      'reconcile-club-member-daily-profit',
                      'ca-resolve-cleared-incidents-hourly']) AS k(jobname)
   WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = k.jobname AND j.active);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'failed: a job kept on purpose is not scheduled: %', v_missing;
  END IF;

  RAISE NOTICE 'PASS: ca-auto-reconcile-tick retired; 121 active of 123; no timer reaches a retired repair path';
END;
$verify$;

COMMIT;
