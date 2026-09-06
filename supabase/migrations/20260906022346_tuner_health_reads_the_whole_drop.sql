-- ═══════════════════════════════════════════════════════════════════════════
-- TUNER HEALTH READS THE WHOLE DROP (2026-09-06)
--
-- fn_audit_fleet_drop_identity is wired in HERE rather than as a new step in
-- fn_run_horse_daily_audit, and deliberately: the identity is not a separate
-- curiosity, it is the PRECONDITION for every verdict fn_audit_tuner_health
-- reports. If the drop is not fully attributed, the regression rule is
-- judging house take, and "221 of 383 regressed" is a symptom of that rather
-- than a fact about 221 horses. A reader who sees one must see the other.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_audit_tuner_health(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  v_rows int;
  v_regress int;
  v_tight int;
  v_play int;
  v_play_age int;
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
    v := v || jsonb_build_object('severity','warn','category','logic','code','tuner_no_rows',
      'title','No self-tune rows for ' || v_run || ' - the leak profiles did not move',
      'evidence', jsonb_build_object('run_date', v_run),
      'recommendation','HorseSelfTuner is the only writer of profiles.horse_profile.leaks*; every night it does not run, the brain reads stale verdicts. See the nightly_job_health finding for the claim.');
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

revoke all on function public.fn_audit_tuner_health(date) from public, authenticated, anon;
grant execute on function public.fn_audit_tuner_health(date) to service_role;
