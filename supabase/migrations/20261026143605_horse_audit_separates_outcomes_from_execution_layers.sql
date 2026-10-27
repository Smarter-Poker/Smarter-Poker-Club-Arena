-- Lower refusal/error counts and floor outcomes are not missing execution layers.
-- Retain their original counts in outcome_counters_quiet; keep applied/usable,
-- eligible/fired, real layer failures and unknown populations visible.
-- Function-only change, no game table DDL, data rewrite or strategy promotion.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_audit_layer_drift(date)'::regprocedure)) <> '6393a510eda9d96181b00e4ce83dae1a' THEN
  RAISE EXCEPTION 'horse outcome audit preimage changed';
 END IF;
END $guard$;
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
           and created_at < (p_day+1)::timestamp at time zone 'UTC'))
       or (feature in ('v36_multiboard_bluff_trim','v36_board_lock','v36_freeroll_bet')
         and not exists (select 1 from horse_brain_telemetry m
           where m.day=p_day and m.feature in ('phase13_board_2','phase13_board_3')
             and m.fires>0)))
  loop
    v_findings := v_findings || jsonb_build_object(
      'severity','warn','category','schema','code','layer_population_unavailable',
      'title','Cannot normalize ' || r.feature || ': original population missing',
      'evidence',jsonb_build_object('feature',r.feature,'day',p_day),
      'recommendation','Check settled floor facts, retained bomb hands and original multi-board decision counters. Missing or expired facts cannot certify a layer or be replaced with all cash decisions.');
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
      or r.feature ~ '^phase13_board_[23]$'
      or r.feature ~ '_seen$'
      or r.feature ~ '^vpip_floor_'
      or r.feature ~ '^phase[0-9]+_context_issue_'
      or r.feature ~ '^phase[0-9]+_([a-z0-9]+_)*execution_(not_executed|coerced|retired_.*)$'
      or r.feature = 'phase15_plan_retirement_unconfirmed'
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
            or feature ~ '^phase13_board_[23]$'
            or feature ~ '^vpip_floor_'
            or feature ~ '^phase[0-9]+_context_issue_'
            or feature ~ '^phase[0-9]+_([a-z0-9]+_)*execution_(not_executed|coerced|retired_.*)$'
            or feature = 'phase15_plan_retirement_unconfirmed'
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
          -- Actual multi-board decisions include non-bomb/RIT sources too.
          when feature in ('v36_multiboard_bluff_trim','v36_board_lock','v36_freeroll_bet')
            then '#multiboard_decisions'
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
               when '#multiboard_decisions' then
                 (select sum(d.fires) from tel d where d.day=x.day
                   and d.feature in ('phase13_board_2','phase13_board_3'))
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
REVOKE ALL ON FUNCTION public.fn_audit_layer_drift(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_drift(date) TO service_role;
DO $overlay_guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_audit_overlays(date)'::regprocedure)) IS DISTINCT FROM '71db43470bb256c8a54c899e03874c5e' THEN
  RAISE EXCEPTION 'horse overlay audit preimage changed';
 END IF;
END $overlay_guard$;
CREATE OR REPLACE FUNCTION public.fn_audit_overlays(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $overlay$
DECLARE v jsonb := '[]'::jsonb; r record; total numeric := 0; n integer := 0;
BEGIN
  FOR r IN
    WITH eligible AS MATERIALIZED (
      SELECT t.id,t.name,t.guaranteed_prize gtd,t.buy_in_amount bi,
             (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=t.id) entries
      FROM public.tournaments t
      WHERE t.guaranteed_prize>0 AND t.buy_in_amount>0
        AND t.started_at >= p_day::timestamp AT TIME ZONE 'UTC'
        AND t.started_at < (p_day+1)::timestamp AT TIME ZONE 'UTC'
    ), funded AS (
      SELECT e.*,
        coalesce((SELECT sum(l.amount) FROM public.chip_ledger l
          WHERE l.tournament_id=e.id AND l.category='overlay'
            AND l.to_type='prize_liability'),0) journal,
        coalesce((SELECT o.amount FROM public.tournament_guarantee_overlays o
          WHERE o.tournament_id=e.id),0) legacy
      FROM eligible e
    ), measured AS (
      -- Same funding precedence as tournament conservation: two records of
      -- one funding are never added together. This is gross recorded funding,
      -- not a claim about net cost after any reviewed return.
      SELECT f.*,greatest(journal,legacy,0) funding,
             greatest(gtd-entries*bi,0) entry_only_gap FROM funded f
    ), counted AS (
      SELECT m.*,sum(funding) OVER () all_funding,
             count(*) FILTER (WHERE funding>0) OVER () funded_events,
             count(*) FILTER (WHERE funding=0 AND entry_only_gap>0) OVER () unconfirmed_events
      FROM measured m WHERE funding>0 OR entry_only_gap>0
    )
    SELECT * FROM counted ORDER BY funding DESC,entry_only_gap DESC,id LIMIT 10
  LOOP
    total:=r.all_funding; n:=r.funded_events;
    v:=v||jsonb_build_object(
      'severity',CASE WHEN r.funding>=200 THEN 'critical' ELSE 'warn' END,
      'category','logic',
      'code',CASE WHEN r.funding>0 THEN 'tournament_overlay' ELSE 'tournament_overlay_estimate' END,
      'title',CASE WHEN r.funding>0 THEN r.name||' has '||round(r.funding,2)||' in recorded guarantee funding'
                   ELSE r.name||' has an entry-only gap with unconfirmed funding' END,
      'evidence',jsonb_build_object('tournament_id',r.id,'guarantee',r.gtd,'buy_in',r.bi,
        'entries',r.entries,'entry_only_gap',r.entry_only_gap,
        'funded_overlay',r.funding,'journal_overlay',r.journal,'legacy_overlay',r.legacy,
        'funding_confirmed',r.funding>0,'basis','gross_recorded_funding',
        'funded_events',r.funded_events,'unconfirmed_events',r.unconfirmed_events),
      'recommendation',CASE WHEN r.funding>0 THEN
        'Recorded guarantee funding is an observed expense, not proof of an overlay-guard defect. Trace the original pre-start eligibility and registration decisions. Entry count now may include late entries; rebuys and subsequent prizes do not erase original funding.'
        ELSE 'This is an entry-only estimate, not money proved paid. Inspect original funding and entry receipts before claiming an overlay or diagnosing the guard.' END);
  END LOOP;
  IF jsonb_array_length(v)>0 THEN
    v:=v||jsonb_build_object('severity','info','category','logic','code','overlay_total',
      'title','Recorded gross guarantee funding: '||round(total,2)||' across '||n||' event(s)',
      'evidence',jsonb_build_object('events',n,'total_overlay',round(total,2),
        'basis','gross_recorded_funding','detail_limit',10),
      'recommendation','Total includes every funded event in the UTC start day, including events beyond the ten displayed details. It is gross recorded funding; entry-only estimates are excluded and reviewed returns are not netted.');
  END IF;
  RETURN v;
END
$overlay$;
REVOKE ALL ON FUNCTION public.fn_audit_overlays(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_overlays(date) TO service_role;
COMMIT;
