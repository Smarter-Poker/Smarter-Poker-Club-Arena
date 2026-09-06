-- ═══════════════════════════════════════════════════════════════════════════
-- THE AUDIT SAYS HOW MUCH PLAY THE BANDS CANNOT JUDGE (2026-09-06)
--
-- Companion to the_floor_is_not_a_leak. Now that floored play is excluded
-- from fn_horse_frequency_leaks and from the tuner, the excluded share is
-- itself a number somebody has to watch: if most of the fleet's cash hands
-- are played at floored tables, the bands are judging a minority of the
-- play and the 1,000-hand gate stops being reached.
--
-- Silently narrowing an input is how the rake bug survived for weeks. This
-- makes the narrowing visible on the panel Dan reads.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_audit_frequency_leaks(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  r record;
  v_studied int;
  v_play_days int;
  v_hands bigint;
  v_floored bigint;
  v_share numeric;
begin
  select count(distinct day) into v_play_days
    from horse_daily_play where day > p_day - 7 and day <= p_day;
  if v_play_days = 0 then
    return v;
  end if;

  -- How much of the window the bands are structurally blind to.
  select coalesce(sum(hands), 0),
         coalesce(sum(hands) filter (where floored), 0)
    into v_hands, v_floored
    from horse_daily_play
   where day > p_day - 7 and day <= p_day and format in ('cash', 'hu_cash');
  v_share := case when v_hands > 0 then round(v_floored::numeric / v_hands, 3) else 0 end;
  if v_floored > 0 then
    v := v || jsonb_build_object(
      'severity', case when v_share >= 0.40 then 'warn' else 'info' end,
      'category', 'logic', 'code', 'frequency_floored_share',
      'title', (v_share * 100)::int || '% of cash hands were played at a VPIP-floored table',
      'evidence', jsonb_build_object('hands', v_hands, 'floored_hands', v_floored, 'share', v_share),
      'recommendation', case when v_share >= 0.40
        then 'The winning-player bands now judge a minority of the fleet''s cash play, and horses may stop reaching the 1,000-hand gate. A floored table REQUIRES loose play (10.5, HorseLogic.vpipFloorMul), so its frequencies cannot be scored against the bands - the answer is fewer floored tables or a floored-table band of its own, not scoring them together.'
        else 'Floored tables require loose play and are excluded from the bands and from the self-tuner by design (see the_floor_is_not_a_leak). This line exists so the exclusion stays visible.' end);
  end if;

  select count(*) into v_studied from fn_horse_frequency_leaks(p_day - 7);
  if v_studied = 0 then
    v := v || jsonb_build_object('severity','info','category','logic','code','frequency_sample_thin',
      'title','No horse has 1,000 unfloored cash hands in the frequency window yet',
      'evidence', jsonb_build_object('play_days', v_play_days, 'floored_share', v_share),
      'recommendation','horse_daily_play is young, or too much of the play is floored. The frequency detectors report from the day a horse crosses 1,000 hands at tables where it was free to fold.');
    return v;
  end if;

  for r in
    select leak, count(*) as horses
      from fn_horse_frequency_leaks(p_day - 7), lateral unnest(leaks) leak
     group by leak
     order by 2 desc
  loop
    if r.horses::numeric / v_studied >= 0.33 then
      v := v || jsonb_build_object('severity','critical','category','gto','code','frequency_leak_fleetwide',
        'title', r.leak || ': ' || r.horses || ' of ' || v_studied || ' studied horses',
        'evidence', jsonb_build_object('leak', r.leak, 'horses', r.horses, 'studied', v_studied,
                                       'share', round(r.horses::numeric / v_studied, 3)),
        'recommendation','A third of the fleet shares this frequency, so it is a threshold in the brain rather than a personality. Find the bar: VPIP and PFR are HorsePreflop open/defend bars, fold-to-3-bet is the facing-raise bar, WWSF and AF are the postflop bluff and value gates. Do not tune dials against it - the dials are already trying and losing.');
    else
      v := v || jsonb_build_object('severity','info','category','gto','code','frequency_leak',
        'title', r.leak || ': ' || r.horses || ' of ' || v_studied || ' studied horses',
        'evidence', jsonb_build_object('leak', r.leak, 'horses', r.horses, 'studied', v_studied,
                                       'share', round(r.horses::numeric / v_studied, 3)),
        'recommendation','Individual horses outside a winning band. The self-tuner moves these dials nightly on the same bands; this line is how to see whether it is working.');
    end if;
  end loop;
  return v;
end $function$;

revoke all on function public.fn_audit_frequency_leaks(date) from public, authenticated, anon;
grant execute on function public.fn_audit_frequency_leaks(date) to service_role;

-- The tuner-health advice named the rake as the only cause of a mass
-- regression. The floor is a second cause with the same shape, and the
-- recommendation is what somebody reads at 3am.
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
      'recommendation','The regression rule is reading the rake as a leak again (2026-09-04: 221 of 383). It must judge net_bb + rake_bb and only a horse under the fleet p25 - see RegressionContext in HorseSelfTuner.ts and TheTunerDoesNotFightTheRake.law.test.ts. Check rake_bb is accumulating in horse_daily_nets.');
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
