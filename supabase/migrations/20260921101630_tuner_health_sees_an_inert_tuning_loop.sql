-- 20260921101630_tuner_health_sees_an_inert_tuning_loop.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_audit_tuner_health could not tell a tuner that MOVED the fleet from a
-- tuner that moved nothing. Every one of its checks counts rows in
-- horse_self_tune_log and reads the reason strings on them; none of them ever
-- asked whether a single horse's profile actually changed.
--
-- Since PR #4578 landed on 2026-09-14 02:31 UTC, HorseSelfTuner writes every
-- study through recordObservationalHorseStudy (HorseTunerObservationalAudit.ts),
-- which deliberately sets nextProfile = expectedProfile and
-- modsAfter = modsBefore, prefixes every reason with "diagnostic proposal, not
-- applied: " and stamps causal_permission = 0. That is a considered decision -
-- a frequency or review correlation is not causal permission to move a dial -
-- and this migration does not change it.
--
-- What it changes is that the decision was INVISIBLE. Measured on production
-- 2026-09-21, mods_before IS NOT DISTINCT FROM mods_after on every row since
-- 2026-09-14:
--
--   run_date    rows  applied  reasons matching 'regress dials halfway'
--   2026-09-13   706      688   131      <- the last night anything applied
--   2026-09-14   705        0   139
--   2026-09-15   692        0   116
--   2026-09-16   651        0   102
--   2026-09-17   622        0    93
--   2026-09-18   649        0   111
--   2026-09-19   594        0   106
--   2026-09-20   581        0   107
--   2026-09-21   565        0   104
--
-- Eight consecutive nights in which the self-tuning loop changed nothing, and
-- the daily audit raised not one finding about it, because "did it write rows"
-- was the only question it knew how to ask. That is the failure mode CLAUDE.md
-- 10.86 names: an instrument that answers confidently when it cannot tell.
--
-- Two corrections, both inside the existing function:
--
--  1. A new finding, tuner_applied_nothing, when the tuner wrote rows and not
--     one of them moved a profile. It carries how many consecutive run_dates
--     have been inert, so a deliberate one-night pause reads differently from a
--     loop that has been dark for a week.
--
--  2. tuner_regressed_the_fleet and tuner_tightened_the_fleet describe their
--     subjects as "tuned horses". With nothing applied those counts are
--     PROPOSALS, so the sentence is false in the one way that matters: it says
--     horses were moved when none were. Both now gate on applied changes and
--     say "proposed" when the run was inert, which also stops a busy
--     proposal-only night raising a critical about dials nobody touched.
--
-- Read-only against every other caller: same signature, same return shape,
-- findings are appended to the same array.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_audit_tuner_health(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v jsonb := '[]'::jsonb;
  v_rows int;
  v_regress int;
  v_tight int;
  v_play int;
  v_play_age int;
  v_claimed boolean;
  v_applied int;
  v_inert_nights int;
  v_noun text;
  v_run date := p_day + 1;
begin
  -- The accounting the rule depends on, first: a verdict below is only
  -- meaningful once the drop is fully attributed.
  v := v || fn_audit_fleet_drop_identity(p_day);

  select count(*),
         count(*) filter (where array_to_string(reasons, ' ') like '%regress dials halfway%'),
         count(*) filter (where array_to_string(reasons, ' ') like '%too loose%'),
         count(*) filter (where (stats->>'study_source')::int = 1),
         count(*) filter (where mods_before is distinct from mods_after)
    into v_rows, v_regress, v_tight, v_play, v_applied
    from horse_self_tune_log where run_date = v_run;

  if v_rows = 0 then
    -- DID IT NOT MOVE, OR HAS IT NOT RUN? The audit for day D runs early on
    -- D+1 and the tuner writes later on D+1, so "no rows yet" is the ordinary
    -- morning state and says nothing about the profiles. The claim row is the
    -- only thing that tells the two apart.
    select exists (
      select 1 from horse_job_runs
      where job = 'self_tuner' and run_date = v_run
    ) into v_claimed;

    if not v_claimed then
      v := v || jsonb_build_object('severity','note','category','logic','code','tuner_not_yet_run',
        'title','The self-tuner has not run for ' || v_run || ' yet - its health is unknown',
        'evidence', jsonb_build_object('run_date', v_run, 'rows', 0, 'claimed', false, 'audited_at', now()),
        'recommendation','Not a defect and not a clean bill of health. The audit for a day runs before the tuner that studies it (measured 2026-09-07: audit 06:05Z, tuner 09:00Z). If horse_job_runs still has no self_tuner claim for this date by ~12:00Z, THEN the job is genuinely missing and nightly_job_health is the finding to read.');
    else
      v := v || jsonb_build_object('severity','warn','category','logic','code','tuner_no_rows',
        'title','The self-tuner claimed ' || v_run || ' and wrote no rows - the leak profiles did not move',
        'evidence', jsonb_build_object('run_date', v_run, 'rows', 0, 'claimed', true),
        'recommendation','HorseSelfTuner is the only writer of profiles.horse_profile.leaks*; every night it does not run, the brain reads stale verdicts. It took the claim and produced nothing, so the failure is inside the run - check horse_error_log context HorseSelfTuner.');
    end if;
    return v;
  end if;

  -- ── ROWS ARE NOT THE SAME THING AS CHANGES (2026-09-21) ──
  -- Every check below this point counts rows in horse_self_tune_log. A study
  -- written through recordObservationalHorseStudy carries modsAfter = modsBefore
  -- on purpose, so a fleet that moved and a fleet that did not move produce
  -- exactly the same row count. Ask the profiles, not the row count.
  if v_applied = 0 then
    -- The current inert streak: every run_date with rows but no applied
    -- change, since the last run_date that did apply one.
    select count(*) into v_inert_nights
      from (
        select l.run_date,
               count(*) filter (where l.mods_before is distinct from l.mods_after) as applied
          from horse_self_tune_log l
         where l.run_date <= v_run
         group by l.run_date
      ) d
     where d.applied = 0
       and d.run_date > coalesce(
         (select max(d2.run_date) from (
            select l2.run_date,
                   count(*) filter (where l2.mods_before is distinct from l2.mods_after) as applied
              from horse_self_tune_log l2
             where l2.run_date <= v_run
             group by l2.run_date
          ) d2 where d2.applied > 0),
         '-infinity'::date);

    v := v || jsonb_build_object('severity','warn','category','logic','code','tuner_applied_nothing',
      'title','The self-tuner studied ' || v_rows || ' horses on ' || v_run || ' and moved none of them'
              || case when v_inert_nights > 1 then ' (' || v_inert_nights || ' consecutive nights)' else '' end,
      'evidence', jsonb_build_object(
        'run_date', v_run, 'rows', v_rows, 'applied', 0,
        'consecutive_inert_nights', v_inert_nights,
        'proposed_regress', v_regress, 'proposed_tighten', v_tight),
      'recommendation','Not automatically a defect: recordObservationalHorseStudy (HorseTunerObservationalAudit.ts, PR #4578, 2026-09-14) writes every study with modsAfter = modsBefore and causal_permission = 0 by design, because a frequency or review correlation is not causal permission to move a dial. What it means is that the self-tuning loop is PROPOSAL-ONLY: the horses are not improving from it, and no amount of nightly study will change that until the separately qualified causal activation path the comment promises actually exists. Confirm the intent is still current and give that path an owner, or the proposals accumulate for ever. If this appears on a night you expected dials to move, the gate is HorseSelfTuner.ts around the recordObservationalHorseStudy call.');
  end if;

  -- With nothing applied these counts are proposals, not moves. Say so, and do
  -- not raise a critical about dials that were never touched.
  v_noun := case when v_applied = 0 then 'proposed' else 'tuned' end;

  if v_applied > 0 and v_regress::numeric / v_rows > 0.4 then
    v := v || jsonb_build_object('severity','critical','category','logic','code','tuner_regressed_the_fleet',
      'title', v_regress || ' of ' || v_rows || ' ' || v_noun || ' horses regressed to neutral on ' || v_run,
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'applied', v_applied, 'regressed', v_regress, 'share', round(v_regress::numeric / v_rows, 3)),
      'recommendation','The regression rule is reading the DROP as a leak again (2026-09-04: 221 of 383). It must judge net_bb + rake_bb + bbj_bb and only a horse under the fleet p25 - see RegressionContext in HorseSelfTuner.ts, TheTunerDoesNotFightTheRake.law.test.ts and TheDropIsTheRakeAndTheJackpot.law.test.ts. Read the drop-identity finding above this one first: if the attribution is short, this number is the shortfall, not 221 broken horses.');
  end if;

  -- A MASS TIGHTENING IS THE SAME CLASS OF BUG (2026-09-06). It ran three
  -- nights running - 104/429, 180/386, 216/383 - because floored tables were
  -- measured against the winning-player band. Whenever half the fleet is
  -- moved the same way, the input is wrong before the dials are.
  if v_applied > 0 and v_tight::numeric / v_rows > 0.40 then
    v := v || jsonb_build_object('severity','critical','category','logic','code','tuner_tightened_the_fleet',
      'title', v_tight || ' of ' || v_rows || ' ' || v_noun || ' horses were tightened for "too loose" on ' || v_run,
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'applied', v_applied, 'tightened', v_tight, 'share', round(v_tight::numeric / v_rows, 3)),
      'recommendation','Half the fleet is not individually too loose - the measurement is. Check that horse_daily_play.floored is being written (a floored table REQUIRES loose play) and that loadPlayRows still filters floored = false. `tightness` is a GLOBAL dial, so a horse tightened for its floored table plays nittier at every ordinary table it sits at.');
  end if;

  select count(distinct day) into v_play_age from horse_daily_play where day > p_day - 7 and day <= p_day;
  if v_play_age >= 6 and v_play::numeric / v_rows < 0.6 then
    v := v || jsonb_build_object('severity','warn','category','schema','code','tuner_studied_from_stream',
      'title', (v_rows - v_play) || ' of ' || v_rows || ' ' || v_noun || ' horses came from the hand_history stream, not horse_daily_play',
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'from_play_rows', v_play, 'play_days_in_window', v_play_age),
      'recommendation','horse_daily_play has a week of rows, so the tuner should study nearly every horse from it. Either the settlement compiler (HorseHandReview.accumulateHorsePlay) is off (HORSE_PLAY_ROLLUP_ENABLED) or loadPlayRows is failing (horse_error_log context HorseSelfTuner.playRows).');
  end if;
  return v;
end
$function$;

-- ── AND CLOSE THE PRE-LOGIN DOOR WHILE WE ARE HERE ──
-- check-definer-authorization refuses this function on the way out: it is
-- SECURITY DEFINER, so it runs as the owner past RLS, and EXECUTE defaults to
-- PUBLIC, which anon inherits. It never calls auth.uid(), auth.role() or
-- auth.jwt(), so an unauthenticated caller could read the fleet's tuning
-- health and every recommendation string in it. That was true before this
-- migration; re-declaring the function is simply the first time a guard has
-- had the chance to say so.
--
-- This is operator and engine telemetry (remedy 1), and it is safe to close:
-- verified on production 2026-09-21 that no RLS policy references it
-- (pg_policies: 0), so it is not a policy helper, and its only in-database
-- caller is fn_run_horse_daily_audit, itself SECURITY DEFINER and owned by
-- postgres. GRANT and REVOKE are not in pgrst_ddl_watch's list, so these two
-- statements cost no schema reload.
REVOKE ALL ON FUNCTION public.fn_audit_tuner_health(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_tuner_health(date) TO service_role;

COMMIT;
