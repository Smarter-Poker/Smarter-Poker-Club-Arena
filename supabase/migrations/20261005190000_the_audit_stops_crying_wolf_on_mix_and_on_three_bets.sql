-- The daily audit stops crying wolf twice (2026-10-05).
--
-- 1. fn_audit_layer_drift: v43_tempo_read and v16_reads_tell are measured per
--    CASH decision, and reason / refusal / miss counters (phaseN_*_reason_*,
--    *_unavailable*, *_skip_*, *_miss_*, v44_declined_*) and the named
--    fallbacks are no longer judged as layers: their lanes are judged on
--    their own _fired / _eligible counters. Replayed over audit days
--    2026-09-28..10-05, collapse warns fall from 73 to 5, all real layers. On 2026-10-04 the fleet swung to 86% tournament hands (cash hands
--    1.18M -> 0.66M) and the audit reported v43 down 62% and
--    v44_declined_governor down 72%. Per cash decision v43 was 1.86 per 1,000
--    against a 1.86-3.29 range, and the governor counter fell because
--    no_think_time (checked first in secondLookPlan) took the same turns.
--    Built on the installed body (md5(prosrc) a7cc50b9541a4bf31f6bc7ee33cdbf54,
--    identical to 20260928144103).
--
-- 2. fn_horse_frequency_leaks: freq_no_3bet is retired. Over 2026-09-21..10-05
--    cash play, the horses it flagged did BETTER than the ones it passed:
--    hold'em-heavy -17.9 vs -23.1 bb/100 (z +2.3), mixed -21.0 vs -28.5
--    (z +3.4), Omaha-heavy -25.9 vs -24.0 (z -0.8, no signal). A leak tag that
--    marks the winners is not a band to tune per variant; it is removed. The
--    three_bet column is still returned. Built on the installed body
--    (md5(prosrc) d12890102df5ed910d8589a6b5a0ae01, identical to
--    20260906020147).

BEGIN;

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

create or replace function public.fn_horse_frequency_leaks(p_since date)
returns table (
  horse_user_id uuid, hands bigint, vpip numeric, pfr_of_vpip numeric,
  three_bet numeric, fold_to_3bet numeric, wwsf numeric, af numeric, leaks text[]
)
language sql stable security definer set search_path = public as $$
  with agg as (
    select p.horse_user_id,
           sum(p.hands)::bigint              as hands,
           sum(p.vpip)::bigint               as vpip,
           sum(p.pfr)::bigint                as pfr,
           sum(p.three_bets)::bigint         as three_bets,
           sum(p.three_bet_opps)::bigint     as three_bet_opps,
           sum(p.faced_3bets)::bigint        as faced_3bets,
           sum(p.fold_to_3bets)::bigint      as fold_to_3bets,
           sum(p.saw_flop)::bigint           as saw_flop,
           sum(p.won_when_saw_flop)::bigint  as won_when_saw_flop,
           sum(p.post_aggr)::bigint          as post_aggr,
           sum(p.post_passive)::bigint       as post_passive
      from horse_daily_play p
     where p.day >= p_since and p.format in ('cash', 'hu_cash')
       and p.floored = false
     group by 1
    having sum(p.hands) >= 1000
  ),
  rates as (
    select a.horse_user_id, a.hands,
           round(a.vpip::numeric / a.hands, 4) as vpip,
           case when a.vpip > 0 then round(a.pfr::numeric / a.vpip, 4) end as pfr_of_vpip,
           case when a.three_bet_opps >= 100 then round(a.three_bets::numeric / a.three_bet_opps, 4) end as three_bet,
           case when a.faced_3bets >= 30 then round(a.fold_to_3bets::numeric / a.faced_3bets, 4) end as fold_to_3bet,
           case when a.saw_flop >= 150 then round(a.won_when_saw_flop::numeric / a.saw_flop, 4) end as wwsf,
           case when a.post_aggr + a.post_passive >= 100 and a.post_passive >= 25
                then round(a.post_aggr::numeric / a.post_passive, 4) end as af
      from agg a
  )
  select r.horse_user_id, r.hands, r.vpip, r.pfr_of_vpip, r.three_bet, r.fold_to_3bet, r.wwsf, r.af,
         array_remove(array[
           case when r.vpip > 0.32 then 'freq_too_loose' end,
           case when r.vpip < 0.19 then 'freq_too_tight' end,
           case when r.pfr_of_vpip is not null and r.pfr_of_vpip < 0.55 then 'freq_limp' end,
           case when r.fold_to_3bet is not null and r.fold_to_3bet > 0.62 then 'freq_over_fold_3bet' end,
           case when r.fold_to_3bet is not null and r.fold_to_3bet < 0.35 then 'freq_sticky_vs_3bet' end,
           case when r.wwsf is not null and r.wwsf < 0.40 then 'freq_surrender_flops' end,
           case when r.af is not null and r.af < 1.2 then 'freq_passive_postflop' end,
           case when r.af is not null and r.af > 3.5 then 'freq_spewy_postflop' end
         ], null) as leaks
    from rates r;
$$;

REVOKE ALL ON FUNCTION public.fn_audit_layer_drift(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_drift(date) TO service_role;
REVOKE ALL ON FUNCTION public.fn_horse_frequency_leaks(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_frequency_leaks(date) TO service_role;

COMMIT;
