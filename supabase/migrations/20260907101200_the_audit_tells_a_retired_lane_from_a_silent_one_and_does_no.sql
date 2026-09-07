-- 20260907101200_the_audit_tells_a_retired_lane_from_a_silent_one_and_does_no.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Two audit detectors answer confidently when they cannot tell. Both were
-- found by the 2026-09-06 daily horse audit analysis, and both are CLAUDE.md
-- 10.86 in its plainest form: "I could not tell" is a distinct outcome and
-- must have its own name. An alarm that is always on is an alarm that gets
-- muted (10.84), and once these two are muted the twenty real findings beside
-- them are muted with them.
--
-- 1. fn_audit_layer_silence reports `layer_silent` for v18_straddle every day
--    and can never do otherwise. Ruling R2 retired the straddle lane on cash
--    games: HorseFleetManager no longer inserts a straddle table, Gate 5's
--    fn_cash_apply_ruleset forces straddle_enabled/auto_utg_straddle/
--    voluntary_straddle false on every cash table on every tick, and two law
--    tests pin that (TheTablesOpenAndCloseThemselves.law.test.ts,
--    LeaguePmAndStraddle.test.ts). Measured 2026-09-07: all 99 tables that
--    still carry straddle_enabled are `closed`, none created since 2026-09-01,
--    all last touched 2026-09-04 22:02Z - which is exactly when the telemetry
--    fell 28,864 -> 1,928 -> 0 over three days. The layer is not broken. Its
--    STAGE was deliberately removed.
--
--    So the watch now asks whether the stage exists before it accuses the
--    brain. No live cash table with straddle_enabled means `layer_retired` at
--    note severity, naming R2. A straddle table that IS live and still draws
--    zero fires keeps the original warn - if R2 is ever reversed the watch
--    comes back on its own, which a deleted row could not do.
--
-- 2. fn_audit_tuner_health races the tuner it is grading. It reads
--    horse_self_tune_log for p_day + 1 - the correct date, because the tuner
--    studies day D on day D+1 - but the audit for day D runs at ~06:05Z on
--    D+1 and the tuner writes at ~08:00-09:40Z on D+1. Measured 2026-09-07:
--    the audit generated 06:05:39Z and filed "No self-tune rows for
--    2026-09-07 - the leak profiles did not move"; the tuner then wrote 490
--    rows starting 09:00:43Z. The finding was false when it was written and
--    is false every day the audit wins the race.
--
--    Zero rows now means one of two different things and says which:
--    horse_job_runs has no ('self_tuner', run_date) claim, so the tuner has
--    NOT RUN YET and the honest answer is a note that nothing is known; or it
--    claimed the day and still wrote nothing, which is the real defect the
--    original warn was written for, and that warn is unchanged.
--
-- Neither function's other findings are touched.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_audit_layer_silence(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_findings jsonb := '[]'::jsonb;
  v_decides bigint;
  v_straddle_stage int;
  feat record;
begin
  select coalesce(sum(fires), 0) into v_decides
  from horse_brain_telemetry where day = p_day and feature = 'decide';

  if v_decides < 1000 then
    return jsonb_build_array(jsonb_build_object(
      'severity','critical','category','schema','code','telemetry_dark',
      'title','Brain telemetry recorded ' || v_decides || ' decisions for ' || p_day,
      'evidence', jsonb_build_object('decide_fires', v_decides),
      'recommendation','Either BrainTelemetryFlush is not running, the deploy predates telemetry, or the fleet was down. Nothing about layer health can be known for this day.'
    ));
  end if;

  -- THE STAGE FOR THE STRADDLE LANE (Ruling R2). Counted, not assumed: a
  -- layer with no stage cannot fire, and that is not the brain's fault.
  select count(*) into v_straddle_stage
  from tables
  where straddle_enabled
    and tournament_id is null
    and status in ('running','waiting');

  for feat in
    select * from (values
      ('preflop_v7',          'critical','the V7 preflop engine - every preflop decision should route through it'),
      ('v15_nut_status',      'critical','V15 Omaha nut awareness - fires on every made flush/straight in PLO'),
      ('banded_mc_omaha',     'critical','Omaha banded equity (the reservoir sampler feeds this path)'),
      ('banded_mc_nlh',       'critical','NLH banded equity'),
      ('icm_real',            'warn','V16 real ICM - tournament decisions with stacks+payouts in context'),
      ('v16_hu_overlay',      'warn','V16 heads-up overlay - any two-handed postflop pot'),
      ('v15_eq_capped',       'warn','V15 equity cap - dominated hands facing aggression'),
      ('v16_reads_cbet',      'warn','deep-read c-bet scaling - needs 10+ observed c-bet opportunities'),
      ('v16_sizecond_bigbet', 'warn','size-conditioned sampling - a 20bb+ bet on the newest street'),
      ('v16_reads_f3b',       'warn','deep-read fold-to-3-bet scaling of the bluff 3-bet mix'),
      ('v16_reads_tell',      'warn','big-river-bet sizing tell - WAS DEAD until the 2026-08-27 scale fix; zero here means the repair did not take'),
      ('v17_pos_behind',      'warn','V17 positional pressure - 0 or 2+ live players behind in a bluff-band spot'),
      ('v17_river_probe',     'warn','V17 river delayed probe - checked-through turn into a short-handed river'),
      ('v17_catch_block',     'warn','V17 call-side blocker - WAS DEAD until the 2026-08-27 scale fix; zero here means the repair did not take'),
      ('v17_short_deck',      'warn','V17 short-deck overlay - every short-deck postflop decision'),
      ('v18_straddle',        'warn','V18 straddle fix - straddled pots re-read as unopened (straddle tables only)'),
      ('v18_self_image',      'warn','V18 self-image - a horse''s own recent line moving its bluff volume'),
      ('v18_exploit_size',    'warn','V18 exploit-sized river value raises'),
      ('v19_overbet_polarity','warn','overbet polarity respect - unreachable before the scale fix'),
      ('v19_river_bigbet_cap','warn','V15 river big-bet equity cap - unreachable before the scale fix')
    ) as t(feature, severity, why)
  loop
    if not exists (
      select 1 from horse_brain_telemetry
      where day = p_day and feature = feat.feature and fires > 0
    ) then
      if feat.feature = 'v18_straddle' and v_straddle_stage = 0 then
        -- RETIRED, NOT SILENT. Ruling R2 took the stage away on purpose.
        v_findings := v_findings || jsonb_build_object(
          'severity','note','category','logic','code','layer_retired',
          'title','Deployed layer v18_straddle has no stage to fire on',
          'evidence', jsonb_build_object(
            'feature','v18_straddle','decide_fires', v_decides,
            'live_straddle_tables', 0,
            'ruling','R2 retired the straddle lane on cash games. fn_cash_apply_ruleset forces straddle_enabled = false on every cash table each tick; pinned by TheTablesOpenAndCloseThemselves.law.test.ts and LeaguePmAndStraddle.test.ts.'),
          'recommendation','Nothing to fix. The code is deployed and correct; the stage was removed deliberately. This turns back into a warn on its own the day a live cash table carries straddle_enabled again - do not "wire up" the flag to silence it, and do not delete the layer.'
        );
      else
        v_findings := v_findings || jsonb_build_object(
          'severity', feat.severity,'category','logic','code','layer_silent',
          'title','Deployed layer ' || feat.feature || ' fired ZERO times',
          'evidence', jsonb_build_object('feature', feat.feature,'decide_fires', v_decides,'expectation', feat.why),
          'recommendation','The code is deployed but never executes at live tables. Find the gate that turned it off - flag defaults, wiring, an upstream condition that can no longer be true, or a threshold on the wrong scale.'
        );
      end if;
    end if;
  end loop;

  return v_findings;
end $function$;

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
  v_run date := p_day + 1;
begin
  -- The accounting the rule depends on, first: a verdict below is only
  -- meaningful once the drop is fully attributed.
  v := v || fn_audit_fleet_drop_identity(p_day);

  select count(*),
         count(*) filter (where array_to_string(reasons, ' ') like '%regress dials halfway%'),
         count(*) filter (where array_to_string(reasons, ' ') like '%too loose%'),
         count(*) filter (where (stats->>'study_source')::int = 1)
    into v_rows, v_regress, v_tight, v_play
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

  if v_regress::numeric / v_rows > 0.4 then
    v := v || jsonb_build_object('severity','critical','category','logic','code','tuner_regressed_the_fleet',
      'title', v_regress || ' of ' || v_rows || ' tuned horses regressed to neutral on ' || v_run,
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'regressed', v_regress, 'share', round(v_regress::numeric / v_rows, 3)),
      'recommendation','The regression rule is reading the DROP as a leak again (2026-09-04: 221 of 383). It must judge net_bb + rake_bb + bbj_bb and only a horse under the fleet p25 - see RegressionContext in HorseSelfTuner.ts, TheTunerDoesNotFightTheRake.law.test.ts and TheDropIsTheRakeAndTheJackpot.law.test.ts. Read the drop-identity finding above this one first: if the attribution is short, this number is the shortfall, not 221 broken horses.');
  end if;

  -- A MASS TIGHTENING IS THE SAME CLASS OF BUG (2026-09-06). It ran three
  -- nights running - 104/429, 180/386, 216/383 - because floored tables were
  -- measured against the winning-player band. Whenever half the fleet is
  -- moved the same way, the input is wrong before the dials are.
  if v_tight::numeric / v_rows > 0.40 then
    v := v || jsonb_build_object('severity','critical','category','logic','code','tuner_tightened_the_fleet',
      'title', v_tight || ' of ' || v_rows || ' tuned horses were tightened for "too loose" on ' || v_run,
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'tightened', v_tight, 'share', round(v_tight::numeric / v_rows, 3)),
      'recommendation','Half the fleet is not individually too loose - the measurement is. Check that horse_daily_play.floored is being written (a floored table REQUIRES loose play) and that loadPlayRows still filters floored = false. `tightness` is a GLOBAL dial, so a horse tightened for its floored table plays nittier at every ordinary table it sits at.');
  end if;

  select count(distinct day) into v_play_age from horse_daily_play where day > p_day - 7 and day <= p_day;
  if v_play_age >= 6 and v_play::numeric / v_rows < 0.6 then
    v := v || jsonb_build_object('severity','warn','category','schema','code','tuner_studied_from_stream',
      'title', (v_rows - v_play) || ' of ' || v_rows || ' tuned horses came from the hand_history stream, not horse_daily_play',
      'evidence', jsonb_build_object('run_date', v_run, 'tuned', v_rows, 'from_play_rows', v_play, 'play_days_in_window', v_play_age),
      'recommendation','horse_daily_play has a week of rows, so the tuner should study nearly every horse from it. Either the settlement compiler (HorseHandReview.accumulateHorsePlay) is off (HORSE_PLAY_ROLLUP_ENABLED) or loadPlayRows is failing (horse_error_log context HorseSelfTuner.playRows).');
  end if;
  return v;
end $function$;

-- OPERATOR TELEMETRY, NOT PLAYER SURFACE. CREATE OR REPLACE re-declares these
-- two, so the grants are restated here rather than inherited silently. This is
-- exactly what production already holds (checked 2026-09-07: proacl is
-- {postgres=X/postgres,service_role=X/postgres} on both, and neither backs any
-- RLS policy - 0 rows in pg_policy reference either name), so this changes no
-- privilege. It states it where the next reader and the pre-push definer check
-- can both see it. PUBLIC is named as well as the roles because anon inherits
-- whatever PUBLIC holds.
REVOKE ALL ON FUNCTION public.fn_audit_layer_silence(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_silence(date) TO service_role;

REVOKE ALL ON FUNCTION public.fn_audit_tuner_health(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_tuner_health(date) TO service_role;

COMMIT;
