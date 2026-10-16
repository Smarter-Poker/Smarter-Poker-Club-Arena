-- 20261016182539_audit_v17_river_probe_is_default_off.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
-- Re-reserved 2026-10-16 when the held patch (docs/horse-brain-pending/) was
-- applied with the opponent-exploit requalification; 20261016101800 was the
-- version it was written under. md5(prosrc) re-checked against production
-- before applying: fn_audit_layer_silence 3c8ce9e89a4d58177b82f99397dda956,
-- fn_audit_league_pooled_findings 542d0d69d10e132101eace69de6c458d (match).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Found by the 2026-10-15 daily horse audit analysis. v17RiverProbe (the V17
-- river delayed probe) is DEFAULT OFF from this change (HorseLogic.ts:
-- `opts.v17RiverProbe === true`). v17_river_probe resolved NEGATIVE pooled
-- over the audit's 7-day window (-0.11 +/- 0.04 bb/100, 8 runs to 2026-10-16)
-- and has never resolved positive (-0.02 +/- 0.03 over all 32 runs since
-- 2026-09-15). The league matchup keeps its name and sign: arm A = probe ON.
--
-- Same treatment the 2026-10-12 migration gave v16Hu, built on the installed
-- bodies (md5(prosrc) of both functions matched 20261012111944 before edit):
--
-- 1. fn_audit_layer_silence: zero v17_river_probe fires is `layer_default_off`
--    (note), not `layer_silent` (warn).
-- 2. fn_audit_league_pooled_findings: a significant negative v17_river_probe
--    confirms the default (info `default_off_flag_confirmed_negative`); a
--    significant POSITIVE one says the flag earned its default back.
--
-- EXTENDED 2026-10-16 (same requalification bundle, same transaction): two
-- more layers measured losing in the daily self-play league are default OFF
-- from this change, the way v17RiverProbe is:
--
--   shortdeck_v23       -0.36 +/- 0.14 bb/100 over 44 runs. Only the
--                       short-deck half of v23Variants is split off
--                       (v23ShortDeck, opt-in); the plo8 low-draw half wins
--                       (+1.63 +/- 0.18) and stays on, as V46 was split.
--   v32_facing_defense  -0.31 +/- 0.15 bb/100 over 41 runs (heads-up NLH);
--                       v32FacingDefense is opt-in.
--
-- Both league matchups keep their names and signs (arm A = layer ON), and
-- V31's empty store is now skipped before its consult (one
-- v31_certified_skip_empty_store counter instead of the miss counters).
-- md5(prosrc) re-checked against production 2026-10-16 before this edit:
-- fn_audit_layer_silence 3c8ce9e89a4d58177b82f99397dda956,
-- fn_audit_league_pooled_findings 542d0d69d10e132101eace69de6c458d,
-- fn_audit_layer_drift 8e70a9a55f691a1bf2b1842530c97383 (= 20261005190000).
--
-- 3. fn_audit_league_pooled_findings: shortdeck_v23 and v32_facing_defense
--    join the default-off list (a significant negative confirms the default;
--    a significant positive says the flag earned its default back).
-- 4. fn_audit_layer_drift, section 1 only (a layer that went silent):
--    a. a feature fn_audit_layer_silence already reported as
--       layer_default_off is skipped, as layer_silent already was (it would
--       otherwise ALSO be reported as layer_went_silent for v17_river_probe);
--    b. the v32_defend_* counters going quiet are a note
--       (layer_default_off, flag v32FacingDefense), not a warn;
--    c. an outcome-breakdown counter (_reason_, unavailable, _skip_, _miss_,
--       v44_declined_), which section 2 already never judges as a layer, is
--       info outcome_counter_went_quiet (cause not determined), not a warn.
--    Section 2 (collapse) is unchanged.
--
-- No other finding in any of the three functions changes.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

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
      elsif feat.feature = 'v17_river_probe' then
        -- DEFAULT OFF, NOT SILENT. HorseLogic gates the river probe on
        -- opts.v17RiverProbe === true; it has been opt-in since 2026-10-16.
        v_findings := v_findings || jsonb_build_object(
          'severity','note','category','logic','code','layer_default_off',
          'title','Opt-in layer v17_river_probe did not fire (default OFF since 2026-10-16)',
          'evidence', jsonb_build_object(
            'feature','v17_river_probe','decide_fires', v_decides,
            'flag','v17RiverProbe','default','off',
            'ruling','v17_river_probe measured -0.11 +/- 0.04 bb/100 pooled over the 8 runs to 2026-10-16 and -0.02 +/- 0.03 over all 32 runs since 2026-09-15: never positive; HorseLogic gates the probe on opts.v17RiverProbe === true.'),
          'recommendation','Nothing to fix. Zero fires is the default-off flag working. Do not turn the flag on to silence this; flip it only on a pooled-SIGNIFICANT positive league result.'
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
      if r.matchup in ('hu_v16_overlay', 'v16_hu_overlay_6max', 'v17_river_probe',
                       'shortdeck_v23', 'v32_facing_defense') then
        -- Arm A runs a DEFAULT-OFF flag ON (v16Hu since 2026-10-05,
        -- v17RiverProbe, v23ShortDeck and v32FacingDefense since 2026-10-16).
        -- A significant negative confirms the default; it is not a defect in
        -- the shipped brain.
        v := v || jsonb_build_object(
          'severity', 'info', 'category', 'gto', 'code', 'default_off_flag_confirmed_negative',
          'title', 'Pooled over ' || r.runs || ' run(s): ' || r.matchup || ' (default-off '
                   || case r.matchup
                        when 'v17_river_probe' then 'v17RiverProbe'
                        when 'shortdeck_v23' then 'v23ShortDeck'
                        when 'v32_facing_defense' then 'v32FacingDefense'
                        else 'v16Hu' end
                   || ' arm) is NEGATIVE at ' || r.bb100 || ' bb/100',
          'evidence', jsonb_build_object('matchup', r.matchup, 'bb100', r.bb100, 'stderr', r.stderr,
                                         'runs', r.runs, 'hands', r.hands, 'newest_run', r.newest_run),
          'recommendation', 'Hypothesis failed as expected; the flag stays default OFF. Nothing to ablate.'
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
    if r.verdict = 'SIGNIFICANT' and r.bb100 > 0 and r.matchup = 'v17_river_probe' then
      v := v || jsonb_build_object(
        'severity', 'info', 'category', 'gto', 'code', 'flagged_experiment_earned_its_keep',
        'title', 'v17_river_probe is pooled-SIGNIFICANT positive (' || r.bb100 || ' bb/100 over ' || r.runs || ' runs)',
        'evidence', jsonb_build_object('bb100', r.bb100, 'stderr', r.stderr, 'runs', r.runs),
        'recommendation', 'The default-OFF river probe has earned its default back. Ship a PR flipping v17RiverProbe to default ON, citing these runs.'
      );
    end if;
    if r.verdict = 'SIGNIFICANT' and r.bb100 > 0
       and r.matchup in ('shortdeck_v23', 'v32_facing_defense') then
      v := v || jsonb_build_object(
        'severity', 'info', 'category', 'gto', 'code', 'flagged_experiment_earned_its_keep',
        'title', r.matchup || ' is pooled-SIGNIFICANT positive (' || r.bb100 || ' bb/100 over ' || r.runs || ' runs)',
        'evidence', jsonb_build_object('bb100', r.bb100, 'stderr', r.stderr, 'runs', r.runs),
        'recommendation', 'The default-OFF layer has earned its default back. Ship a PR flipping '
                          || case when r.matchup = 'shortdeck_v23' then 'v23ShortDeck' else 'v32FacingDefense' end
                          || ' to default ON, citing these runs.'
      );
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

CREATE OR REPLACE FUNCTION public.fn_audit_layer_drift(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_findings jsonb := '[]'::jsonb;
  v_decides bigint;
  v_already text[];
  r record;
  /*
   * FALLBACK COUNTERS: SILENCE IS THE GOAL, BUT NOT ALWAYS THE CAUSE
   * Some counters name the DEGRADED path, not a layer: icm_legacy is the flat
   * heuristic used only when TournamentBrainContext arrives without stacks or
   * payouts (icm_real takes over the moment it has them), icm_warming is a
   * context that has not arrived yet, gto_depth_fallback and gto_miss_* are
   * the solver store having no cell for the spot. Zero fires on a big day is
   * the INTENDED direction for all of them, so their silence is info rather
   * than a warning - the six-day icm_legacy migration to icm_real reached
   * exactly zero on 2026-09-04 and this function used to report it as a layer
   * that "was executing and is not any more".
   *
   * What this function CANNOT tell (2026-09-12) is WHY one went quiet. The
   * primary genuinely covering every spot, and the whole lane being retired by
   * a deploy, produce an identical zero here. On 2026-09-11 all three
   * gto_miss_* counters read zero and were reported as "the primary path
   * covered every spot" while their primary, v31_gto_open, had itself been
   * removed from the source by PR #3849 and the certified store it was
   * repointed at was empty. So the title now states only what was counted and
   * the recommendation names both causes. A fallback that starts firing AGAIN
   * is caught by the ratio checks in fn_audit_data_receipts, not here.
   */
  v_fallback_exact constant text[] := array['icm_legacy', 'icm_warming', 'gto_depth_fallback'];
  v_fallback_prefix constant text[] := array['gto_miss_'];
  v_is_fallback boolean;
  /*
   * DEFAULT-OFF LAYERS (2026-10-16). A layer whose flag the league turned OFF
   * by default stops firing the day that release ships. That is the flag
   * working, not a broken gate, so it is a note naming the flag, never
   * layer_went_silent. Single-name layers (v17_river_probe, v16_hu_overlay)
   * are reported by fn_audit_layer_silence as layer_default_off and skipped
   * here through v_already.
   */
  v_default_off_prefix constant text[] := array['v32_defend_'];
  v_is_default_off boolean;
begin
  select coalesce(sum(fires), 0) into v_decides
    from horse_brain_telemetry where day = p_day and feature = 'decide';

  if v_decides < 1000 then
    return v_findings;
  end if;

  select coalesce(array_agg(f->'evidence'->>'feature'), '{}')
    into v_already
    from jsonb_array_elements(fn_audit_layer_silence(p_day)) f
   where f->>'code' in ('layer_silent', 'layer_default_off');

  -- 1. A layer that was firing and stopped.
  for r in
    with hist as (
      select feature,
             count(*) filter (where day < p_day and fires > 0) as prior_days,
             coalesce(max(fires) filter (where day = p_day), 0) as today,
             coalesce(sum(fires) filter (where day < p_day), 0) as prior_fires,
             max(day) filter (where day < p_day and fires > 0) as last_fired
        from horse_brain_telemetry
       where day between p_day - 7 and p_day and feature <> 'decide'
       group by feature
    )
    select * from hist
     where prior_days >= 2 and today = 0 and not (feature = any(v_already))
     order by prior_fires desc
  loop
    v_is_fallback := r.feature = any(v_fallback_exact)
      or exists (select 1 from unnest(v_fallback_prefix) p where left(r.feature, length(p)) = p);
    if v_is_fallback then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'info',
        'category', 'logic',
        'code', 'fallback_went_quiet',
        'title', 'Fallback ' || r.feature || ' fired ' || r.prior_fires ||
                 ' times in the previous week and ZERO on ' || p_day,
        'evidence', jsonb_build_object(
          'feature', r.feature,
          'prior_days_active', r.prior_days,
          'prior_fires', r.prior_fires,
          'last_fired', r.last_fired,
          'decide_fires', v_decides,
          'cause_not_determined', true
        ),
        'recommendation',
          'This counter names a degraded path (the legacy ICM heuristic, a ' ||
          'warming context, a solver-store miss), so zero is the intended ' ||
          'direction and this is not a warning. It does NOT by itself mean the ' ||
          'primary path covered every spot - this check cannot tell that from ' ||
          'the whole lane having been retired by a deploy, and the two look ' ||
          'identical here. Separate them in one step: if the fallback primary ' ||
          'is still firing today the coverage reading is the right one; if the ' ||
          'primary also read zero, or its feature name no longer appears in ' ||
          'server/src, the lane was retired and this counter should be deleted ' ||
          'with it. Measured 2026-09-11: all three gto_miss_* counters reached ' ||
          'zero because PR #3849 removed their primary v31_gto_open on ' ||
          '2026-09-08 and repointed the read path at a certified store that ' ||
          'holds no rows - which is the opposite of coverage. If it starts ' ||
          'firing again the receipts audit will say so.'
      );
      continue;
    end if;
    v_is_default_off := exists (select 1 from unnest(v_default_off_prefix) p
                                 where left(r.feature, length(p)) = p);
    if v_is_default_off then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'note',
        'category', 'logic',
        'code', 'layer_default_off',
        'title', 'Opt-in layer ' || r.feature || ' fired ' || r.prior_fires ||
                 ' times in the previous week and ZERO on ' || p_day ||
                 ' (default OFF since 2026-10-16)',
        'evidence', jsonb_build_object(
          'feature', r.feature,
          'prior_days_active', r.prior_days,
          'prior_fires', r.prior_fires,
          'last_fired', r.last_fired,
          'decide_fires', v_decides,
          'flag', 'v32FacingDefense',
          'default', 'off',
          'ruling', 'v32_facing_defense measured -0.31 +/- 0.15 bb/100 over 41 nightly league runs; HorseLogic gates the V32 consult on opts.v32FacingDefense === true.'
        ),
        'recommendation',
          'Nothing to fix. Zero fires is the default-off flag working. Do not ' ||
          'turn the flag on to silence this; flip it only on a pooled-SIGNIFICANT ' ||
          'positive league result.'
      );
      continue;
    end if;
    -- 2026-10-16: the same outcome-breakdown counters section 2 never judges
    -- as layers (a reason, a skip, a miss, a refusal) are not layers here
    -- either. A quiet one means that outcome stopped happening: on 2026-10-16
    -- the V31 empty-store misses stop because an empty store is skipped
    -- before the consult and counted once as v31_certified_skip_empty_store.
    if r.feature ~ '(_reason_|unavailable|_skip_|_miss_|^v44_declined_)' then
      v_findings := v_findings || jsonb_build_object(
        'severity', 'info',
        'category', 'logic',
        'code', 'outcome_counter_went_quiet',
        'title', 'Outcome counter ' || r.feature || ' fired ' || r.prior_fires ||
                 ' times in the previous week and ZERO on ' || p_day,
        'evidence', jsonb_build_object(
          'feature', r.feature,
          'prior_days_active', r.prior_days,
          'prior_fires', r.prior_fires,
          'last_fired', r.last_fired,
          'decide_fires', v_decides,
          'cause_not_determined', true
        ),
        'recommendation',
          'This counter names WHY a lane did or did not act, not a layer; the ' ||
          'lane is judged on its own fired / eligible counters. Zero can be good ' ||
          'news (fewer misses or refusals) or the lane retired by a deploy, and ' ||
          'this check cannot tell which. If the lane''s own counters also went ' ||
          'quiet, look at the lane.'
      );
      continue;
    end if;
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'logic',
      'code', 'layer_went_silent',
      'title', 'Layer ' || r.feature || ' fired ' || r.prior_fires ||
               ' times in the previous week and ZERO on ' || p_day,
      'evidence', jsonb_build_object(
        'feature', r.feature,
        'prior_days_active', r.prior_days,
        'prior_fires', r.prior_fires,
        'last_fired', r.last_fired,
        'decide_fires', v_decides
      ),
      'recommendation',
        'This layer was executing and is not any more. Trace the gate: a flag ' ||
        'default, an upstream condition that can no longer be true, or a newer ' ||
        'layer returning before it. A retired layer is a valid answer - if the ' ||
        'feature name no longer exists in the source it is not a regression, ' ||
        'and this finding should be answered by deleting the counter.'
    );
  end loop;

  -- 2. A layer that collapsed without going silent - REPORTED ON THE DAY OF
  --    THE STEP ONLY (2026-09-04), AND MEASURED AGAINST ITS OWN POPULATION
  --    (2026-09-28).
  --
  --    Until 2026-09-28 every layer's rate was fires per 1,000 FLEET decisions.
  --    That divides out fleet volume but not table MIX: when the fleet swung
  --    toward tournaments on 2026-09-27 (decide_tournament 1.72M -> 2.22M) every
  --    FLH, PKO, spin and cash counter "collapsed" at once - 113 warns - while
  --    phase12_flh_fired / phase13_variant_flh was 98.5%, higher than the day
  --    before. The same flood is what let a real V15 decay (v15_nut_status per
  --    Omaha decision 4.5% -> 3.3%) pass unflagged.
  --
  --    Each layer is now divided by the population it can fire on:
  --      * population counters (decide_*, phaseN_variant_/format_/objective_*,
  --        *_seen) are the mix itself, not layers - never judged here;
  --      * phaseN_<variant>_*       -> phaseN_variant_<variant> (else phase13's);
  --      * phase13_* and *_utility_cash, vpip_floor_* -> cash decisions
  --        (decide - decide_tournament; phase13_utility_cash equals it exactly);
  --      * phase13 tournament hand-offs, icm_*           -> decide_tournament;
  --      * bounty layers            -> PKO + mystery-bounty decisions;
  --      * spin layers              -> phase8_format_spin;
  --      * v15_*                    -> decide_omaha; v17_short_deck -> decide_short_deck;
  --      * v43_tempo_read, v16_reads_tell -> cash decisions (2026-10-05);
  --      * reason / refusal / miss counters and named fallbacks are a lane's
  --        outcome breakdown, never judged as layers (2026-10-05);
  --      * other phaseN_*           -> phaseN_seen; everything else -> decide.
  --    And a layer whose own population fell at least as far as it did is not
  --    collapsing, whatever its rate says. Replayed on 2026-09-27 this leaves
  --    10 of 113 warns.
  for r in
    with tel as (
      select day, feature, sum(fires)::numeric as fires
        from horse_brain_telemetry
       where day between p_day - 7 and p_day
       group by day, feature
    ),
    tot as (
      select day,
             max(fires) filter (where feature = 'decide') as decide,
             coalesce(max(fires) filter (where feature = 'decide_tournament'), 0) as tourn,
             coalesce(sum(fires) filter (where feature in ('phase7_objective_pko',
                                                           'phase7_objective_mystery_bounty')), 0) as bounty
        from tel
       group by day
      having max(fires) filter (where feature = 'decide') > 1000
    ),
    keyed as (
      select distinct feature,
        case
          when feature ~ '^decide(_|$)'
            or feature ~ '^phase[0-9]+_(variant|format|objective)_'
            or feature ~ '_seen$' then null
          -- 2026-10-05: REASON counters are a breakdown of a lane's outcomes,
          -- not layers. Every phaseN decision notes exactly one *_reason_*,
          -- the V44 second look notes one v44_declined_* per refusal, and
          -- *_unavailable* / *_skip_* / *_miss_* name why a path was not
          -- taken. A drop in one is a shift inside the lane (fewer refusals
          -- is usually good news); the lane itself is judged on its own
          -- *_fired / *_eligible / v44_second_look counters, which stay here.
          -- Replayed over 2026-09-28..10-05 this leaves 5 of 73 warns, every
          -- one of them a real layer. The fallbacks this function already
          -- names as intended-to-fall are excluded for the same reason.
          when feature ~ '(_reason_|unavailable|_skip_|_miss_|^v44_declined_)'
            or feature = any(v_fallback_exact) then null
          -- 2026-10-05: both reads need a river bettor with a showdown
          -- history, a cash-table read. Per fleet decide they swung 5x with
          -- the tournament share (v43 0.39-2.15 per 1,000); per cash decision
          -- they held (v43 1.86-3.29, v16_reads_tell 6.5-11.5), 09-24..10-05.
          when feature in ('v43_tempo_read', 'v16_reads_tell') then '#cash'
          when feature ~ '^phase13_(unavailable_utility_context|utility_phase7)' then 'decide_tournament'
          when feature ~ '(utility_cash$|^vpip_floor_)' then '#cash'
          when feature ilike '%bounty%' then '#bounty'
          when feature ~ '^icm_' then 'decide_tournament'
          when feature ~ 'spin' then 'phase8_format_spin'
          when feature ~ '^v15_' then 'decide_omaha'
          when feature = 'v17_short_deck' then 'decide_short_deck'
          when feature ~ '^phase[0-9]+_(flh|flo8|nlh|plo4|plo5|plo6|plo8|pineapple|short_deck)_' then
            regexp_replace(feature,
              '^(phase[0-9]+)_(flh|flo8|nlh|plo4|plo5|plo6|plo8|pineapple|short_deck)_.*$',
              '\1_variant_\2')
          when feature ~ '^phase13_' then '#cash'
          when feature ~ '^phase[0-9]+_' then regexp_replace(feature, '^(phase[0-9]+)_.*$', '\1_seen')
          else 'decide'
        end as den_key
        from tel
       where feature <> 'decide'
    ),
    den as (
      select k.feature, x.day, k.den_key,
             case k.den_key
               when '#cash'   then x.decide - x.tourn
               when '#bounty' then x.bounty
               when 'decide'  then x.decide
               else coalesce(
                 (select d.fires from tel d where d.day = x.day and d.feature = k.den_key),
                 case when k.den_key ~ '^phase[0-9]+_variant_' then
                   (select d.fires from tel d
                     where d.day = x.day
                       and d.feature = regexp_replace(k.den_key, '^phase[0-9]+_', 'phase13_'))
                 end)
             end as den
        from keyed k
        cross join tot x
       where k.den_key is not null
    ),
    rate as (
      select t.feature, t.day, t.fires, d.den, d.den_key,
             (t.fires * 1000) / d.den as rate
        from tel t
        join den d using (feature, day)
       where d.den > 1000
    ),
    cur  as (select feature, rate as cur_rate,  fires as cur_fires,  den as cur_den, den_key
               from rate where day = p_day),
    prev as (select feature, rate as prev_rate, fires as prev_fires, den as prev_den
               from rate where day = p_day - 1),
    base as (
      select feature,
             (percentile_cont(0.5) within group (order by rate))::numeric as med_rate,
             count(*) as n_days,
             sum(fires) as prior_fires
        from rate where day < p_day group by feature
    )
    select c.feature, c.cur_rate, c.cur_fires, c.cur_den, c.den_key,
           b.med_rate, b.n_days, b.prior_fires,
           p.prev_rate, p.prev_fires, p.prev_den
      from cur c
      join base b using (feature)
      left join prev p using (feature)
     where b.n_days >= 3
       and b.prior_fires >= 5000
       and b.med_rate > 0
       and c.cur_rate < b.med_rate * 0.40
       -- THE STEP MUST BE NEW. If yesterday was already below the line, this
       -- is the same step reported again - the median simply has not rolled
       -- past it yet. Reporting it daily for a week is what buried three real
       -- criticals under three false ones on 2026-09-01.
       and (p.prev_rate is null or p.prev_rate >= b.med_rate * 0.40)
       -- AND IT MUST ACTUALLY HAVE FALLEN. icm_legacy went 441 -> 641 fires
       -- and v16_unblocker 2,428 -> 2,512 on the day they were both reported
       -- as collapsing. A layer whose raw count rose is not collapsing today,
       -- whatever a median that straddles a deploy says.
       and (p.prev_fires is null or c.cur_fires < p.prev_fires)
       -- AND ITS OWN POPULATION MUST NOT HAVE FALLEN AS FAR (2026-09-28). A
       -- layer that kept pace with the tables it can fire on is not broken.
       and not (p.prev_den is not null and p.prev_fires > 0
                and c.cur_den / p.prev_den <= c.cur_fires / p.prev_fires)
     order by (1 - c.cur_rate / b.med_rate) desc
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity', 'warn',
      'category', 'logic',
      'code', 'layer_fire_collapse',
      'title', 'Layer ' || r.feature || ' fell to ' ||
               round(100 * (1 - r.cur_rate / r.med_rate)) || '% below its usual rate',
      'evidence', jsonb_build_object(
        'feature', r.feature,
        'denominator', r.den_key,
        'denominator_today', r.cur_den,
        'denominator_yesterday', r.prev_den,
        'rate_per_1k_today', round(r.cur_rate, 2),
        'rate_per_1k_yesterday', round(coalesce(r.prev_rate, 0), 2),
        'rate_per_1k_median', round(r.med_rate, 2),
        'pct_drop', round(100 * (1 - r.cur_rate / r.med_rate)),
        'fires_today', r.cur_fires,
        'fires_yesterday', coalesce(r.prev_fires, 0),
        'prior_fires', r.prior_fires,
        'baseline_days', r.n_days,
        'step_day', p_day
      ),
      'recommendation',
        'Reported ONLY on the day the step happened, and measured per 1,000 of ' ||
        'the layer''s OWN population (the ''denominator'' in the evidence), so ' ||
        'a shift in table mix is already divided out. Still worth confirming ' ||
        'rather than assuming: a SUPERSEDED layer legitimately declining ' ||
        '(icm_legacy as icm_real took over), a newer layer that RETURNS EARLY ' ||
        'displacing the ones below it (V32 did exactly that to v16_reads_tell ' ||
        'and v16_unblocker on 2026-08-31), and - where the denominator is a ' ||
        'whole variant - a cash/tournament split inside that variant, which ' ||
        'telemetry cannot yet separate. The remaining explanation is a broken gate.'
    );
  end loop;

  return v_findings;
end
$function$;

-- Operator/engine telemetry: already closed live; stated here so the
-- migration is self-describing and the definer-authorization check passes.
REVOKE ALL ON FUNCTION public.fn_audit_layer_silence(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_silence(date) TO service_role;
REVOKE ALL ON FUNCTION public.fn_audit_league_pooled_findings(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_league_pooled_findings(date) TO service_role;
REVOKE ALL ON FUNCTION public.fn_audit_layer_drift(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_drift(date) TO service_role;

COMMIT;
