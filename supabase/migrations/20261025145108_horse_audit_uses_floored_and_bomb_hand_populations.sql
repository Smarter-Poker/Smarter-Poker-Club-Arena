-- @live-proof: SELECT position('#floored_cash_seat_hands' IN pg_get_functiondef('public.fn_audit_layer_drift(date)'::regprocedure)) > 0 AND position('#bomb_hands' IN pg_get_functiondef('public.fn_audit_layer_drift(date)'::regprocedure)) > 0
-- October24 false collapses: floored cash seat-hands 532921 -> 104205;
-- VPIP fires/seat-hand stayed 2.37-2.48. Bomb hands6877 ->1272;
-- V36 fires/bomb-hand stayed11.85-14.22. Cash/fleet decide denominators
-- cannot distinguish that mix. Use the original settled floor flag and
-- actual bomb hands, not today's mutable table settings. Missing population
-- stays unknown (no rate); no guessed zero or fallback to fleet decides.
-- Child VPIP counters describe outcomes within vpip_floor, not execution.
-- No DDL on hot tables, no scans of ca_hand_facts, no production writes,
-- no retained-history rewrite, no schedules and no strategy promotion.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
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
   * RETIRED AND OUTCOME COUNTERS ARE NOT LAYERS (2026-10-16)
   * On 2026-10-15 this loop raised about 110 layer_went_silent warns and none
   * was a layer that stopped executing. They were (a) reason codes RENAMED or
   * RETIRED with the code that fired them - the Phase 12 pack's pre-round-3
   * reasons (phase12_*reason_variant_*, *_preflop_*, *_split_*, *_low_only_*,
   * now round3_*), the earlier PLO packs' heads_up_big_blind_three_bet,
   * v44_declined_governor, and the packs' wall-clock *_reason_work_budget that
   * the 2026-10-16 policy bundle retires - and (b) reason, refusal and
   * failure counters (phase13_*reason_insufficient_joint_samples,
   * *_capacity_unavailable, *_unavailable_utility_*) and population counters
   * (phase8_objective_*), whose zero is a shift inside a lane or in the table
   * mix. Section 2 already stopped judging (b) as layers on 2026-10-05; the
   * lane itself is still judged by its own *_fired / *_eligible counters.
   *
   * (a) is read from horse_data_ledger: the engine registers a retired key as
   * kind 'receipt', cadence 'legacy_unused' (HorseDataLedger.ts,
   * RETIRED_RECEIPTS), and its silence is the retirement - one info line
   * lists them. (b) is classified by the same patterns as section 2 and
   * reported as one info line naming the counters, never one warn each.
   */
  v_retired_quiet text[] := '{}';
  v_outcome_quiet text[] := '{}';
  v_outcome_quiet_fires bigint := 0;
begin
  select coalesce(sum(fires), 0) into v_decides
    from horse_brain_telemetry where day = p_day and feature = 'decide';

  if v_decides < 1000 then
    return v_findings;
  end if;

  select coalesce(array_agg(f->'evidence'->>'feature'), '{}')
    into v_already
    from jsonb_array_elements(fn_audit_layer_silence(p_day)) f
   where f->>'code' = 'layer_silent';

  -- A missing original population is UNKNOWN, never evidence of health.
  for r in
    select feature from horse_brain_telemetry
     where day=p_day and fires>0 and (
       (feature='vpip_floor' and not exists (
         select 1 from horse_daily_play where day=p_day and floored
           and format in ('cash','hu_cash') and hands>0))
       or (feature in ('v36_bomb_multiboard','v36_bomb_single') and not exists (
         select 1 from hand_history where bomb_pot is not null
           and created_at >= p_day::timestamp at time zone 'UTC'
           and created_at < (p_day+1)::timestamp at time zone 'UTC')))
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity','warn','category','schema','code','layer_population_unavailable',
      'title','Cannot normalize ' || r.feature || ': original population missing',
      'evidence',jsonb_build_object('feature',r.feature,'day',p_day),
      'recommendation','Check settled floor facts and retained bomb hands. Missing or expired facts cannot certify a layer or be replaced with all cash decisions.');
  end loop;

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
    if exists (
      select 1 from horse_data_ledger l
       where l.kind = 'receipt' and l.cadence = 'legacy_unused'
         and split_part(l.key, ':', 2) = r.feature
    ) then
      v_retired_quiet := v_retired_quiet || r.feature;
      continue;
    end if;
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
    if r.feature ~ '^decide(_|$)'
      or r.feature ~ '^phase[0-9]+_(variant|format|objective)_'
      or r.feature ~ '_seen$'
      or r.feature ~ '(_reason_|unavailable|_skip_|_miss_|^v44_declined_)' then
      v_outcome_quiet := v_outcome_quiet || r.feature;
      v_outcome_quiet_fires := v_outcome_quiet_fires + r.prior_fires;
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
        'This counter was firing and is not any more. Check current protected policy selections (an unselected candidate remains in shadow), then trace a flag ' ||
        'default, an upstream condition that can no longer be true, or a newer ' ||
        'layer returning before it. A retired layer is a valid answer - if the ' ||
        'feature name no longer exists in the source it is not a regression, ' ||
        'and this finding should be answered by deleting the counter.'
    );
  end loop;

  if cardinality(v_retired_quiet) > 0 then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'info',
      'category', 'logic',
      'code', 'retired_counters_quiet',
      'title', cardinality(v_retired_quiet) || ' retired counter(s) fired in the previous week and ZERO on ' || p_day,
      'evidence', jsonb_build_object('features', to_jsonb(v_retired_quiet), 'decide_fires', v_decides),
      'recommendation',
        'Each is registered in horse_data_ledger as a retired receipt (HorseDataLedger.ts ' ||
        'RETIRED_RECEIPTS): the code that fired it was renamed or removed, so zero is the ' ||
        'retirement. If one fires again, the ledger row is wrong and should be removed.'
    );
  end if;
  if cardinality(v_outcome_quiet) > 0 then
    v_findings := v_findings || jsonb_build_object(
      'severity', 'info',
      'category', 'logic',
      'code', 'outcome_counters_quiet',
      'title', cardinality(v_outcome_quiet) || ' reason, refusal or population counter(s) fired in the previous week and ZERO on ' || p_day,
      'evidence', jsonb_build_object(
        'features', to_jsonb(v_outcome_quiet[1:60]),
        'feature_count', cardinality(v_outcome_quiet),
        'prior_fires', v_outcome_quiet_fires,
        'decide_fires', v_decides),
      'recommendation',
        'A reason, refusal or failure counter names WHY a lane took a path, and a population ' ||
        'counter is the table mix; zero is a shift inside a lane (fewer refusals is usually ' ||
        'good news) or a mix change, not a layer that stopped. The lanes are judged by their ' ||
        'own *_fired / *_eligible counters. A reason that was renamed or retired belongs in ' ||
        'horse_data_ledger as a retired receipt (HorseDataLedger.ts RETIRED_RECEIPTS).'
    );
  end if;

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
    floor_hands as (
      select day, sum(hands)::numeric as hands from horse_daily_play
       where day between p_day - 7 and p_day
         and format in ('cash','hu_cash') and floored
       group by day
    ),
    bomb_hands as (
      select (created_at at time zone 'UTC')::date as day, count(*)::numeric as hands
        from hand_history where bomb_pot is not null
         and created_at >= (p_day - 7)::timestamp at time zone 'UTC'
         and created_at < (p_day + 1)::timestamp at time zone 'UTC'
       group by 1
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
          when feature = 'vpip_floor' then '#floored_cash_seat_hands'
          when feature like 'vpip_floor_%' then 'vpip_floor'
          when feature in ('v36_bomb_multiboard','v36_bomb_single') then '#bomb_hands'
          when feature in ('v43_tempo_read', 'v16_reads_tell') then '#cash'
          when feature ~ '^phase13_(unavailable_utility_context|utility_phase7)' then 'decide_tournament'
          when feature ~ 'utility_cash$' then '#cash'
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
               when '#floored_cash_seat_hands' then
                 (select f.hands from floor_hands f where f.day = x.day)
               when '#bomb_hands' then
                 (select b.hands from bomb_hands b where b.day = x.day)
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
        'this narrows the population but cannot exclude all table-mix changes. Confirm ' ||
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

REVOKE ALL ON FUNCTION public.fn_audit_layer_drift(date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_drift(date) TO service_role;
CREATE OR REPLACE FUNCTION public.fn_run_horse_daily_audit(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_stats jsonb;
  v_findings jsonb := '[]'::jsonb;
  r record;
  v_day_hands bigint;
  v_base_hands bigint;
  v_base_days int;
  v_big_pots bigint;
  c_min_baseline_days constant int := 3;
begin
  select jsonb_build_object(
    'flagged_hands', count(*),
    'big_wins', count(*) filter (where is_win),
    'big_losses', count(*) filter (where not is_win),
    'net_bb_sum', round(coalesce(sum(net_bb), 0), 1),
    'by_variant', coalesce((select jsonb_object_agg(game_variant, cnt) from (select game_variant, count(*) cnt from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 group by game_variant) v), '{}'::jsonb),
    'by_format', coalesce((select jsonb_object_agg(format, cnt) from (select format, count(*) cnt from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 group by format) v), '{}'::jsonb),
    'decides', (select coalesce(sum(fires),0) from horse_brain_telemetry where day = p_day and feature = 'decide'),
    'net_bb_all_hands', (select round(coalesce(sum(net_bb),0),1) from horse_daily_nets where day = p_day)
  ) into v_stats from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1;

  select count(*) into v_day_hands
    from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1;

  -- ── THE BASELINE COMES FROM THE ROLLUP (2026-09-05) ──
  -- The seven-day baseline and the thirty-day first-seen scan used to read
  -- horse_hand_reviews with a lateral unnest over leak_tags - every row's
  -- heap page, actions jsonb and all, for up to a month of rows. Warm that is
  -- a second; cold it was most of a 41.8s run measured on 2026-09-05 after
  -- the hand_history scan was already gone, against an 8s ceiling. The
  -- engine's 06:00 window is exactly when those pages are cold.
  -- horse_review_rollup is the same counts per horse/day/variant, written by
  -- fn_hhr_rollup_add on every review insert, a few thousand small rows for a
  -- week. Verified on the live data: first-seen days identical for all 22
  -- tags; seven-day hand counts and tag counts within 0.1% (the rollup add is
  -- fire-and-forget and loses a handful of rows), which moves a per-1k rate
  -- in the third decimal and no verdict. The DAY side stays on
  -- horse_hand_reviews, exact and hot.
  select coalesce(sum(big_wins + big_losses), 0), count(distinct day)
    into v_base_hands, v_base_days
    from horse_review_rollup where day >= p_day - 7 and day < p_day;

  if v_base_days >= c_min_baseline_days and v_day_hands > 0 and v_base_hands > 0 then
    for r in
      with day_tags as (
        select tag, count(*) cnt
          from horse_hand_reviews, lateral unnest(leak_tags) tag
         where played_at >= p_day and played_at < p_day + 1
         group by tag
      ),
      tag_first_seen as (
        select k as tag, min(day) as first_day
          from horse_review_rollup, lateral jsonb_object_keys(leak_counts) k
         where day >= p_day - 30 and day <= p_day
         group by k
      ),
      base_day_hands as (
        select day as d, sum(big_wins + big_losses)::bigint as hands
          from horse_review_rollup
         where day >= p_day - 7 and day < p_day
         group by 1
      ),
      base_tag_counts as (
        select k as tag, sum((leak_counts->>k)::bigint) as cnt
          from horse_review_rollup, lateral jsonb_object_keys(leak_counts) k
         where day >= p_day - 7 and day < p_day
         group by k
      ),
      base_per_tag as (
        select f.tag,
               coalesce(sum(b.hands), 0)::bigint as hands,
               count(b.d)::int                   as days
          from tag_first_seen f
          left join base_day_hands b on b.d >= f.first_day
         group by f.tag
      )
      select d.tag,
             d.cnt,
             (d.cnt::numeric * 1000) / v_day_hands as day_rate,
             case when p.hands > 0
                  then (coalesce(c.cnt, 0)::numeric * 1000) / p.hands
             end                                  as base_rate,
             coalesce(p.days, 0)                   as tag_base_days,
             coalesce(p.hands, 0)                  as tag_base_hands
        from day_tags d
        left join base_per_tag  p using (tag)
        left join base_tag_counts c using (tag)
       where d.cnt >= 20
    loop
      if r.tag_base_days < c_min_baseline_days then
        v_findings := v_findings || jsonb_build_object(
          'severity','info','category','logic','code','leak_tag_detector_new',
          'title','Leak tag ' || r.tag || ' is too new to baseline',
          'evidence', jsonb_build_object(
            'tag', r.tag,
            'count', r.cnt,
            'rate_per_1k', round(r.day_rate, 2),
            'tag_baseline_days', r.tag_base_days,
            'required_days', c_min_baseline_days,
            'day_hands', v_day_hands),
          'recommendation','This detector has not been running long enough for a spike to mean anything, so no comparison was made. Its first few days establish the baseline; judge it from the day it has ' || c_min_baseline_days || ' full prior days.');
      elsif r.base_rate is not null
            and (r.base_rate = 0 or r.day_rate > r.base_rate * 1.5) then
        declare
          /*
           * A RISE IS NOT A LEAK UNTIL THE MIRRORED EV SAYS SO (2026-09-14).
           * The count above is the LOSS side only. fn_horse_tag_ev pairs it
           * with its _won mirror over seven days, which is the ranking
           * fn_audit_river_aggression_ev already treats as the honest one. A
           * situation that is winning money did not regress because it
           * happened more often. Null means under 100 hands in the window, or
           * the fold family, which has no winning mirror by construction -
           * then the original warn stands, because nothing contradicted it.
           */
          v_situation text := case
            when r.tag like '%\_won'  then left(r.tag, length(r.tag) - 4)
            when r.tag like '%\_lost' then left(r.tag, length(r.tag) - 5)
            else r.tag
          end;
          v_ev_bb    numeric;
          v_ev_hands bigint;
          v_ev_win   numeric;
          v_ev_z     numeric;
          v_ev_sd    numeric;
        begin
          select e.bb_per_hand, e.hands, e.win_rate
            into v_ev_bb, v_ev_hands, v_ev_win
            from fn_horse_tag_ev(p_day - 6) e
           where e.situation = v_situation and e.mirrored
           limit 1;
          select s.z, s.sd_est into v_ev_z, v_ev_sd
            from fn_horse_tag_ev_significance(p_day - 6) s
           where s.situation = v_situation
           limit 1;

          if v_ev_bb is not null and v_ev_bb >= 0 then
            v_findings := v_findings || jsonb_build_object(
              'severity','info','category','gto','code','leak_tag_spike_positive_ev',
              'title','Leak tag ' || r.tag || ' rose, and its mirrored situation is WINNING ' || v_ev_bb || 'bb per hand',
              'evidence', jsonb_build_object(
                'tag', r.tag,
                'situation', v_situation,
                'count', r.cnt,
                'rate_per_1k', round(r.day_rate, 2),
                'baseline_rate_per_1k', round(r.base_rate, 2),
                'baseline_days', r.tag_base_days,
                'day_hands', v_day_hands,
                'baseline_hands', r.tag_base_hands,
                'mirrored_bb_per_hand', v_ev_bb,
                'mirrored_hands', v_ev_hands,
                'mirrored_win_rate', v_ev_win),
              'recommendation','Counted on the loss side alone this rose, which is what the spike threshold saw. Counted on BOTH sides over seven days it MAKES money, so the rise is the fleet reaching the spot more often, not the brain regressing into it. Do not tune away from it on this finding and do not open a league matchup for it. It becomes a real warning on its own the day fn_horse_tag_ev turns the situation negative.');
          elsif v_ev_bb is not null and v_ev_z is not null and v_ev_z > -3 then
            -- NEGATIVE IS NOT THE SAME AS LOSING (2026-09-27). See migration header.
            v_findings := v_findings || jsonb_build_object(
              'severity','info','category','gto','code','leak_tag_spike_unresolved',
              'title','Leak tag ' || r.tag || ' rose, but its mirrored EV (' || v_ev_bb || 'bb/hand, z ' || v_ev_z || ') is indistinguishable from zero',
              'evidence', jsonb_build_object(
                'tag', r.tag, 'situation', v_situation, 'count', r.cnt,
                'rate_per_1k', round(r.day_rate, 2), 'baseline_rate_per_1k', round(r.base_rate, 2),
                'mirrored_bb_per_hand', v_ev_bb, 'mirrored_hands', v_ev_hands,
                'mirrored_sd_est', v_ev_sd, 'mirrored_z', v_ev_z, 'z_gate', -3),
              'recommendation','The spot is arising more often, but seven days of both outcomes cannot tell it from breakeven. Do not tune on it and do not open a matchup for it. It becomes a warning the day its z falls to -3 or below.');
          else
            v_findings := v_findings || jsonb_build_object(
              'severity', case when r.base_rate = 0 or r.day_rate > r.base_rate * 2.5 then 'critical' else 'warn' end,
              'category','logic','code','leak_tag_spike',
              'title','Leak tag ' || r.tag || ' spiked',
              'evidence', jsonb_build_object(
                'tag', r.tag,
                'count', r.cnt,
                'rate_per_1k', round(r.day_rate, 2),
                'baseline_rate_per_1k', round(r.base_rate, 2),
                'baseline_days', r.tag_base_days,
                'day_hands', v_day_hands,
                'baseline_hands', r.tag_base_hands,
                'mirrored_bb_per_hand', v_ev_bb,
                'mirrored_hands', v_ev_hands),
              'recommendation','Rates are per 1,000 captured hands on both sides and the baseline counts only days this detector was live, so this is neither a volume artifact nor a new-detector artifact. mirrored_bb_per_hand is the seven-day EV across BOTH outcomes: negative confirms a real leak, and null means the situation has under 100 hands in the window or has no winning mirror (the fold family), so the rise is unexplained rather than confirmed. A spike after a deploy means the brain regressed on this pattern. Diff the day''s engine deploys against the tag definition and sample flagged hands carrying it.');
          end if;
        end;
      end if;
    end loop;
  else
    v_findings := v_findings || jsonb_build_object(
      'severity','info','category','logic','code','leak_tag_spike_baseline_thin',
      'title','Leak spike detection stood down - ' || v_base_days || ' day(s) of baseline',
      'evidence', jsonb_build_object('baseline_days', v_base_days, 'required_days', c_min_baseline_days,
                                     'day_hands', v_day_hands, 'baseline_hands', v_base_hands),
      'recommendation','Needs ' || c_min_baseline_days || ' distinct prior days of capture before a spike means anything. This is the detector declining to guess, not a finding.');
  end if;

  -- Tournament chips at changing blind levels are not cash-game bb EV.
  -- Keep both observations, with separate comparison cohorts and labels.
  for r in
    with results as (
      select horse_user_id,
        case when tournament_id is null then 'cash' else 'tournament' end as lane,
        sum(net_bb) as net, count(*) as n
      from horse_hand_reviews where played_at>=p_day and played_at<p_day+1
      group by horse_user_id, (tournament_id is null)
    )
    select horse_user_id,lane,round(net,1) as net,n from results hr
    where net < least(-400,(select percentile_cont(0.1) within group(order by f.net)
      from results f where f.lane=hr.lane))
    order by net limit 10
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity',case when r.lane='tournament' then 'info' when r.net < -800 then 'critical' else 'warn' end,
      'category','gto',
      'code',case when r.lane='tournament' then 'horse_tournament_big_pot_result' else 'horse_big_pot_bleed' end,
      'title','Horse lost ' || abs(r.net) || 'bb across ' || r.n || ' flagged ' || r.lane || ' pots',
      'evidence',jsonb_build_object('horse_user_id',r.horse_user_id,
        'alias',(select coalesce(alias,display_name,username) from profiles where id=r.horse_user_id),
        'net_bb',r.net,'hands',r.n,'format',r.lane,
        'tags',(select coalesce(jsonb_object_agg(tag,cnt),'{}'::jsonb) from (
          select tag,count(*) cnt from horse_hand_reviews,lateral unnest(leak_tags) tag
          where horse_user_id=r.horse_user_id and played_at>=p_day and played_at<p_day+1
            and (tournament_id is null)=(r.lane='cash') group by tag) t)),
      'recommendation',case when r.lane='tournament' then
        'This is a tournament chip result across changing blinds, not cash EV or proof of a style defect. Review commitment-street actions, starting stacks and tournament utility before changing a dial.'
        else 'Review this horse''s cash flagged hands and both outcome mirrors. A negative captured-pot total alone does not establish a style defect; inspect commitment-street decisions and the hand count.' end);
  end loop;

  for r in select matchup, bb100, stderr, illegal_actions from horse_league_results
    where run_date = (select max(run_date) from horse_league_results where run_date <= p_day + 1)
  loop
    if r.bb100 < 0 and abs(r.bb100) > 2 * r.stderr then
      v_findings := v_findings || jsonb_build_object('severity',case when r.matchup in ('hu_v16_overlay','v16_hu_overlay_6max') then 'info' else 'critical' end,
        'category','gto','code',case when r.matchup in ('hu_v16_overlay','v16_hu_overlay_6max') then 'league_inactive_layer_negative' else 'league_layer_negative' end,
        'title','League matchup ' || r.matchup || ' resolves NEGATIVE','evidence', jsonb_build_object('matchup',r.matchup,'bb100',r.bb100,'stderr',r.stderr),
        'recommendation',case when r.matchup in ('hu_v16_overlay','v16_hu_overlay_6max') then
        'V16Hu is default off in protected source. The on-arm lost; this supports retaining the default and is not evidence that production applies the layer. Recheck source defaults before proposing an ablation.'
        else 'A strategy layer is measurably losing money in self-play. Check its current default and candidate selection, then ablate any active layer properly before tuning.' end);
    end if;
    if r.illegal_actions > 0 then
      v_findings := v_findings || jsonb_build_object('severity','critical','category','logic','code','league_illegal_actions',
        'title','League matchup ' || r.matchup || ' produced illegal actions','evidence', jsonb_build_object('matchup',r.matchup,'illegal_actions',r.illegal_actions),
        'recommendation','The brain emitted a sizing the engine rejects. This reaches live tables as silent check/fold degradation - find the exact branch.');
    end if;
  end loop;

  -- ── capture_coverage_gap (rewritten 2026-09-05) ──────────────────────────
  -- This step used to scan the WHOLE DAY of hand_history (681,878 rows on
  -- 2026-09-04: 700,896 buffers through idx_hand_history_created with a heap
  -- filter on pot_size, 89.9 seconds measured) to answer a question whose
  -- normal answer is "nothing to report". It was the entire reason the
  -- engine's nightly daily_audit could not finish: service_role runs at an
  -- 8s statement_timeout and the engine client aborts at 15s, and the SET
  -- statement_timeout '60s' on this function cannot re-arm a timer that was
  -- armed at statement start. Every other step here runs in under a second.
  --
  -- The question is "did a variant deal big pots today and write NO review
  -- rows". Both halves are cheap without hand_history: the variants dealt
  -- come from horse_daily_nets (written per horse-hand at settlement, one
  -- small row per horse/variant/day), the variants reviewed come from
  -- idx_hhr_played. Only for a variant that has nets rows and no reviews -
  -- the abnormal case the finding exists for - is hand_history probed, and
  -- then with LIMIT 50: fifty big pots are enough to raise the finding and
  -- the scan stops the moment it has them.
  for r in
    select n.game_variant
      from (select distinct game_variant from horse_daily_nets where day = p_day and hands > 0) n
     where not exists (select 1 from horse_hand_reviews rv
                        where rv.game_variant = n.game_variant
                          and rv.played_at >= p_day and rv.played_at < p_day + 1)
  loop
    select count(*) into v_big_pots from (
      select 1 from hand_history h
       where h.created_at >= p_day and h.created_at < p_day + 1
         and h.game_variant = r.game_variant
         and h.pot_size >= 40 * h.big_blind
       limit 50) probe;
    if v_big_pots >= 50 then
      v_findings := v_findings || jsonb_build_object('severity','critical','category','schema','code','capture_coverage_gap',
        'title','Variant ' || r.game_variant || ' dealt at least ' || v_big_pots || ' big pots but wrote zero review rows',
        'evidence', jsonb_build_object('game_variant',r.game_variant,'big_pot_hands',v_big_pots,'probe_limit',50),
        'recommendation','recordHorseHandReviews is not firing for this variant''s settlement path. Read the engine logs for HorseHandReview reportError entries.');
    end if;
  end loop;

  select count(*) into r from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 and (hole_cards is null or board is null);
  if (r.count) >= 25 then
    v_findings := v_findings || jsonb_build_object('severity','warn','category','schema','code','evidence_payload_missing',
      'title',(r.count) || ' review rows missing hole_cards or board','evidence', jsonb_build_object('rows',r.count),
      'recommendation','parseCards rejected the payload shape, or preflop-only pots legitimately have no board. Sample the rows.');
  end if;

  for r in select id, horse_user_id, net_bb, game_variant, format, tournament_id, big_blind from horse_hand_reviews
    where played_at >= p_day and played_at < p_day + 1
      and abs(net_bb) > (case when tournament_id is not null then 1500 else 500 end)
      order by abs(net_bb) desc limit 5
  loop
    v_findings := v_findings || jsonb_build_object('severity','warn','category','schema','code','net_outlier',
      'title','Review row with |net| of ' || r.net_bb || 'bb','evidence', jsonb_build_object('review_id',r.id,'horse_user_id',r.horse_user_id,'net_bb',r.net_bb,'variant',r.game_variant,'format',r.format,'tournament_id',r.tournament_id,'big_blind',r.big_blind),
      'recommendation','Cross-check the captured pre-action stack, contributions and returns. Cash rebuy history and early tournament blind levels can legitimately produce deep bb stacks; a fixed bb threshold alone does not prove an accounting error.');
  end loop;

  select count(*) into r from horse_hand_reviews where played_at >= p_day and played_at < p_day + 1 and not is_win and leak_tags = '{}';
  if (r.count) >= 200 then
    v_findings := v_findings || jsonb_build_object('severity','info','category','logic','code','untagged_losses',
      'title',(r.count) || ' big losses carry no leak tag','evidence', jsonb_build_object('rows',r.count),
      'recommendation','Not every big loss is a mistake - but if manual review keeps finding the same untagged flaw, add a detector.');
  end if;

  v_findings := v_findings || fn_audit_layer_silence_and_coverage(p_day);
  v_findings := v_findings || fn_audit_fleet_health(p_day);
  -- 2026-09-01: a claimed-but-empty nightly job, a stale league card,
  -- and a matchup whose two arms are identical. See
  -- 20260901_audit_a_lost_nightly_job_is_loud.sql.
  v_findings := v_findings || fn_audit_nightly_job_health(p_day);
  -- 2026-09-27: the audit reports its own missing days. daily_audit claimed
  -- 2026-09-26 and wrote nothing, and no instrument said so.
  for r in
    select j.run_date, j.claimed_at, j.claimed_by
      from horse_job_runs j
     where j.job = 'daily_audit'
       and j.run_date between p_day - 2 and p_day - 1
       and not exists (select 1 from horse_daily_audit x where x.day = j.run_date)
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity','critical','category','schema','code','daily_audit_lost',
      'title','daily_audit claimed ' || r.run_date || ' and never wrote its row',
      'evidence', jsonb_build_object('run_date', r.run_date, 'claimed_at', r.claimed_at, 'claimed_by', r.claimed_by),
      'recommendation','The engine calls this function as service_role, whose statement_timeout is 8s. Run select fn_run_horse_daily_audit(''' || r.run_date || '''::date) from a session with a longer timeout to recover the day, then find the step that outgrew 8s.');
  end loop;
  -- 2026-09-01: river aggression judged on EV across BOTH outcomes.
  v_findings := v_findings || fn_audit_river_aggression_ev(p_day);
  -- 2026-09-01: layers that stopped firing or collapsed, derived from
  -- what each layer has actually done - no hand-maintained watchlist.
  v_findings := v_findings || fn_audit_layer_drift(p_day);
  -- 2026-09-01: a conservation breach stays reported until a person
  -- explains it. The deploy gate forgets after four hours; this does not.
  v_findings := v_findings || fn_audit_supply_breaches(p_day);
  -- Phase 1 of the real-time build plan (2026-09-04): every ledger receipt
  -- judged against its expected share, every nightly source for freshness.
  v_findings := v_findings || fn_audit_data_receipts(p_day);
  -- 2026-09-05 hardening: the tag registry, the tuner, the seat clock.
  v_findings := v_findings || fn_audit_tag_consumers(p_day);
  v_findings := v_findings || fn_audit_tuner_health(p_day);
  v_findings := v_findings || fn_audit_seat_clock(p_day);
  -- 2026-09-06: a receipt can be zero because the behaviour is broken OR
  -- because the world never presents the spot. Those want opposite fixes.
  v_findings := v_findings || fn_audit_behaviour_has_a_stage(p_day);
  -- 2026-09-05 V49: the leaks a 20bb loss cannot see.
  v_findings := v_findings || fn_audit_frequency_leaks(p_day);
  -- 2026-09-05 V47: the absolute score the league cannot produce.
  v_findings := v_findings || fn_audit_solver_agreement(p_day);
  -- 2026-09-08 Phase 4: certified corpus and independent pipeline liveness.
  v_findings := v_findings || fn_audit_gto_v31_certified(p_day);
  v_findings := v_findings || fn_audit_solver_pipeline_liveness(p_day);
  -- 2026-09-05: the tournament lane scoreboard, compiled for the day then judged.
  perform fn_horse_tournament_daily_compile(p_day);
  v_findings := v_findings || fn_audit_tournament_results(p_day);

  insert into horse_daily_audit as a (day, generated_at, stats, findings)
  values (p_day, now(), coalesce(v_stats,'{}'::jsonb), v_findings)
  on conflict (day) do update set generated_at = now(), stats = excluded.stats, findings = excluded.findings;

  return jsonb_build_object('day', p_day, 'findings', jsonb_array_length(v_findings));
end
$function$;
REVOKE ALL ON FUNCTION public.fn_run_horse_daily_audit(date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_run_horse_daily_audit(date) TO service_role;
COMMIT;
