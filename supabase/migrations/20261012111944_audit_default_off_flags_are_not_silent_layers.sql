-- 20261012111944_audit_default_off_flags_are_not_silent_layers.sql
--
-- Found by the 2026-10-11 daily horse audit analysis.
--
-- v16Hu (the V16 heads-up overlay) has been DEFAULT OFF since 2026-10-05
-- (HorseLogic.ts: `opts.v16Hu === true`), after hu_v16_overlay measured
-- -0.26 +/- 0.10 bb/100 pooled over 31 nightly runs. Two audit detectors still
-- treat it as a deployed, always-on layer and raise criticals that are the
-- decision working as intended:
--
-- 1. fn_audit_layer_silence reports `layer_silent` (warn) for v16_hu_overlay
--    every day. Zero fires is correct for a default-off flag. It is now a
--    note, `layer_default_off`, naming the flag and the ruling. A fire count
--    above zero still produces no finding, as before.
--
-- 2. fn_audit_league_pooled_findings reports `league_layer_negative_pooled`
--    (critical) for hu_v16_overlay / v16_hu_overlay_6max. Those matchups run
--    arm A with the flag ON against the default (OFF), so a significant
--    negative result CONFIRMS the default. It is now an info finding
--    `default_off_flag_confirmed_negative`. Any other matchup is unchanged.
--
-- No other finding in either function changes.

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
      elsif feat.feature = 'v16_hu_overlay' then
        -- DEFAULT OFF, NOT SILENT. HorseLogic gates the overlay on
        -- opts.v16Hu === true; it has been opt-in since 2026-10-05.
        v_findings := v_findings || jsonb_build_object(
          'severity','note','category','logic','code','layer_default_off',
          'title','Opt-in layer v16_hu_overlay did not fire (default OFF since 2026-10-05)',
          'evidence', jsonb_build_object(
            'feature','v16_hu_overlay','decide_fires', v_decides,
            'flag','v16Hu','default','off',
            'ruling','hu_v16_overlay measured -0.26 +/- 0.10 bb/100 pooled over 31 nightly runs (z -2.6); HorseLogic gates the overlay on opts.v16Hu === true.'),
          'recommendation','Nothing to fix. Zero fires is the default-off flag working. Do not turn the flag on to silence this; flip it only on a pooled-SIGNIFICANT positive league result.'
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

CREATE OR REPLACE FUNCTION public.fn_audit_league_pooled_findings(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb := '[]'::jsonb; r record;
begin
  for r in select * from fn_league_pooled(p_day, 7) loop
    if r.verdict = 'SIGNIFICANT' and r.bb100 < 0 then
      if r.matchup in ('hu_v16_overlay', 'v16_hu_overlay_6max') then
        -- Arm A runs the DEFAULT-OFF v16Hu flag ON. A significant negative
        -- confirms the default; it is not a defect in the shipped brain.
        v := v || jsonb_build_object(
          'severity', 'info', 'category', 'gto', 'code', 'default_off_flag_confirmed_negative',
          'title', 'Pooled over ' || r.runs || ' run(s): ' || r.matchup || ' (default-off v16Hu arm) is NEGATIVE at ' || r.bb100 || ' bb/100',
          'evidence', jsonb_build_object('matchup', r.matchup, 'bb100', r.bb100, 'stderr', r.stderr,
                                         'runs', r.runs, 'hands', r.hands, 'newest_run', r.newest_run),
          'recommendation', 'Hypothesis failed as expected; v16Hu stays default OFF. Nothing to ablate.'
        );
      else
        v := v || jsonb_build_object(
          'severity', 'critical', 'category', 'gto', 'code', 'league_layer_negative_pooled',
          'title', 'Pooled over ' || r.runs || ' run(s): ' || r.matchup || ' resolves NEGATIVE at ' || r.bb100 || ' bb/100',
          'evidence', jsonb_build_object('matchup', r.matchup, 'bb100', r.bb100, 'stderr', r.stderr,
                                         'runs', r.runs, 'hands', r.hands, 'newest_run', r.newest_run),
          'recommendation', 'This layer is measurably losing money across every night it was measured. Ablate it properly before tuning anything else - and check whether a recent change to it caused the flip.'
        );
      end if;
    end if;
    if r.verdict = 'SIGNIFICANT' and r.bb100 > 0 and r.matchup = 'v16_ratio_rescale' then
      v := v || jsonb_build_object(
        'severity', 'info', 'category', 'gto', 'code', 'flagged_experiment_earned_its_keep',
        'title', 'v16_ratio_rescale is pooled-SIGNIFICANT positive (' || r.bb100 || ' bb/100 over ' || r.runs || ' runs)',
        'evidence', jsonb_build_object('bb100', r.bb100, 'stderr', r.stderr, 'runs', r.runs),
        'recommendation', 'The default-OFF experiment has earned its default. Ship a PR flipping v16Ratio to default ON, citing these runs.'
      );
    end if;
  end loop;
  return v;
end $function$;

COMMIT;
