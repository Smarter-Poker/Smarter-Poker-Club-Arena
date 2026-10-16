-- 20261016192158_the_horse_brain_reports_its_daily_reference_agreement.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY: Horse Brain Phase 15 daily reference-agreement
-- report (table, writer function, reader function), and the daily audit's
-- layer drift reading retired and outcome counters for what they are
-- (fn_audit_layer_drift, at the end). All DDL in ONE
-- transaction (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- HORSE BRAIN PHASE 15: DAILY REFERENCE-AGREEMENT REPORT (2026-10-16)
--
-- docs/horse-brain-round1-playbook.md, Phase 15: "Implement out-of-domain
-- detection, deterministic replay, mixed-frequency tests, component/fleet
-- liveness and daily reference-agreement reporting." The report was never
-- built (docs/horse-phase15-component-accounting-2026-09-14.md: "not ... the
-- daily silence alarms"; audit 2026-10-16: "daily reference-agreement report
-- NOT BUILT").
--
-- One row per UTC day in horse_reference_agreement_daily, computed from the
-- day's horse_brain_telemetry counters only (no hands, cards, players or
-- tables):
--   by_variant      per (variant, cash|tournament): live FAST decisions and how
--                   their final policy action compares with the action the
--                   policy graph's reference node produced (exact, same action
--                   other amount, different action, unrecorded graph), from
--                   phase15_reference_agreement_* (HorsePolicyLedgerObserver);
--   divergence      per (variant, node): the first graph node that moved the
--                   action off the reference, from phase15_reference_divergence_*;
--   policy_outcomes per variant: the registered pack's reconciled outcome
--                   (computed, outside_domain, unavailable, reference,
--                   disabled), from phase15_policy_* (HorseLogic);
--   second_looks    why deep second looks were retired, from
--                   phase15_deep_execution_retired_* (HorseExecutionWitness);
--   findings        what the day shows against the trailing seven complete
--                   days (rules below), never a repair instruction.
-- `complete` is true only when the row was generated after the day closed.
--
-- Agreement with the reference is a consistency measure of the live policy
-- graph, not strength and not GTO: a pack that beats the reference is
-- expected to disagree with it where it is right to.
--
-- The engine's daily job (HorseReferenceAgreementReport.ts, claim key
-- 'reference_agreement' in horse_job_runs) calls fn_run_horse_reference_
-- agreement for the completed previous day. Read with
-- ca_horse_reference_agreement(days).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.horse_reference_agreement_daily (
  day             date PRIMARY KEY,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  complete        boolean NOT NULL,
  totals          jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_variant      jsonb NOT NULL DEFAULT '[]'::jsonb,
  divergence      jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
  second_looks    jsonb NOT NULL DEFAULT '{}'::jsonb,
  findings        jsonb NOT NULL DEFAULT '[]'::jsonb
);

COMMENT ON TABLE public.horse_reference_agreement_daily IS
  'Horse Brain Phase 15 daily reference-agreement report: live FAST decisions per variant and format against the policy graph reference node, divergence by node, registered policy outcomes (out-of-domain, unavailable) and deep second-look retirement reasons, from horse_brain_telemetry. Written by fn_run_horse_reference_agreement (engine daily job HorseReferenceAgreementReport).';

ALTER TABLE public.horse_reference_agreement_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.horse_reference_agreement_daily FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.horse_reference_agreement_daily TO service_role;

CREATE OR REPLACE FUNCTION public.fn_run_horse_reference_agreement(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '60s'
AS $$
DECLARE
  v_by_variant jsonb;
  v_divergence jsonb;
  v_outcomes jsonb;
  v_second jsonb;
  v_totals jsonb;
  v_findings jsonb;
  v_complete boolean := now() >= (p_day + 1)::timestamptz;
BEGIN
  IF p_day IS NULL OR p_day > current_date THEN
    RAISE EXCEPTION 'fn_run_horse_reference_agreement: day % is not a past or current UTC day', p_day;
  END IF;

  WITH a AS (
    SELECT m[1] AS variant, m[2] AS format, m[3] AS agreement, t.fires
    FROM public.horse_brain_telemetry t,
         LATERAL regexp_match(t.feature,
           '^phase15_reference_agreement_(.+)_(cash|tournament)_(exact|action|differ|unrecorded)$') m
    WHERE t.day = p_day AND t.feature LIKE 'phase15_reference_agreement_%' AND m IS NOT NULL
  ), g AS (
    SELECT variant, format,
           sum(fires) AS decisions,
           coalesce(sum(fires) FILTER (WHERE agreement = 'exact'), 0) AS exact,
           coalesce(sum(fires) FILTER (WHERE agreement = 'action'), 0) AS action_only,
           coalesce(sum(fires) FILTER (WHERE agreement = 'differ'), 0) AS differ,
           coalesce(sum(fires) FILTER (WHERE agreement = 'unrecorded'), 0) AS unrecorded
    FROM a GROUP BY variant, format
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'variant', variant, 'format', format, 'decisions', decisions,
           'exact', exact, 'action', action_only, 'differ', differ, 'unrecorded', unrecorded,
           'agreement', CASE WHEN decisions - unrecorded > 0
             THEN round(exact::numeric / (decisions - unrecorded), 6) END,
           'action_agreement', CASE WHEN decisions - unrecorded > 0
             THEN round((exact + action_only)::numeric / (decisions - unrecorded), 6) END)
         ORDER BY variant, format), '[]'::jsonb),
         jsonb_build_object(
           'decisions', coalesce(sum(decisions), 0),
           'exact', coalesce(sum(exact), 0),
           'action', coalesce(sum(action_only), 0),
           'differ', coalesce(sum(differ), 0),
           'unrecorded', coalesce(sum(unrecorded), 0),
           'agreement', CASE WHEN coalesce(sum(decisions - unrecorded), 0) > 0
             THEN round(sum(exact)::numeric / sum(decisions - unrecorded), 6) END)
    INTO v_by_variant, v_totals
  FROM g;

  SELECT coalesce(jsonb_agg(jsonb_build_object('variant', m[1], 'node', m[2], 'decisions', t.fires)
           ORDER BY m[1], t.fires DESC, m[2]), '[]'::jsonb)
    INTO v_divergence
  FROM public.horse_brain_telemetry t,
       LATERAL regexp_match(t.feature,
         '^phase15_reference_divergence_(.+)_(reference_legality|variant_policy|tournament_utility|tournament_continuation|variant_utility_guard|joint_policy|timing)$') m
  WHERE t.day = p_day AND t.feature LIKE 'phase15_reference_divergence_%' AND m IS NOT NULL;

  WITH o AS (
    SELECT m[1] AS variant, m[2] AS outcome, t.fires
    FROM public.horse_brain_telemetry t,
         LATERAL regexp_match(t.feature,
           '^phase15_policy_(.+)_(reference|disabled|computed|outside_domain|unavailable)$') m
    WHERE t.day = p_day AND t.feature LIKE 'phase15_policy_%' AND m IS NOT NULL
  ), v AS (
    SELECT variant, sum(fires) AS decisions,
           coalesce(sum(fires) FILTER (WHERE outcome = 'computed'), 0) AS computed,
           coalesce(sum(fires) FILTER (WHERE outcome = 'outside_domain'), 0) AS outside_domain,
           coalesce(sum(fires) FILTER (WHERE outcome = 'unavailable'), 0) AS unavailable,
           coalesce(sum(fires) FILTER (WHERE outcome = 'reference'), 0) AS reference,
           coalesce(sum(fires) FILTER (WHERE outcome = 'disabled'), 0) AS disabled
    FROM o GROUP BY variant
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'variant', variant, 'decisions', decisions, 'computed', computed,
           'outside_domain', outside_domain, 'unavailable', unavailable,
           'reference', reference, 'disabled', disabled,
           'outside_domain_share', round(outside_domain::numeric / decisions, 6),
           'unavailable_share', round(unavailable::numeric / decisions, 6))
         ORDER BY variant), '[]'::jsonb)
    INTO v_outcomes
  FROM v WHERE decisions > 0;

  SELECT coalesce(jsonb_object_agg(m[1], t.fires ORDER BY m[1]), '{}'::jsonb)
    INTO v_second
  FROM public.horse_brain_telemetry t,
       LATERAL regexp_match(t.feature, '^phase15_deep_execution_retired_([a-z_]+)$') m
  WHERE t.day = p_day AND t.feature LIKE 'phase15_deep_execution_retired_%' AND m IS NOT NULL;

  -- Findings against the trailing seven complete reports (only rows that were
  -- themselves complete). Each rule names its threshold:
  --   agreement_drop     a (variant, format) with >= 1,000 decisions whose exact
  --                      agreement fell more than 2 points below its trailing mean;
  --   unrecorded_graph   any decision without a sealed policy graph (baseline 0);
  --   ood_rise           a variant whose out-of-domain share rose more than 5
  --                      points above its trailing mean (>= 1,000 decisions);
  --   unavailable_rise   a variant whose unavailable share exceeds 1% and doubled
  --                      its trailing mean (>= 1,000 decisions);
  --   no_report_input    no reference-agreement counters at all for the day.
  WITH prev AS (
    SELECT r.day, r.by_variant, r.policy_outcomes
    FROM public.horse_reference_agreement_daily r
    WHERE r.day < p_day AND r.day >= p_day - 7 AND r.complete
  ), pv AS (
    SELECT e->>'variant' AS variant, e->>'format' AS format, avg((e->>'agreement')::numeric) AS agreement
    FROM prev, jsonb_array_elements(prev.by_variant) e
    WHERE (e->>'agreement') IS NOT NULL
    GROUP BY 1, 2
  ), po AS (
    SELECT e->>'variant' AS variant,
           avg((e->>'outside_domain_share')::numeric) AS ood,
           avg((e->>'unavailable_share')::numeric) AS unav
    FROM prev, jsonb_array_elements(prev.policy_outcomes) e
    GROUP BY 1
  ), f AS (
    SELECT jsonb_build_object('rule', 'agreement_drop', 'variant', c->>'variant', 'format', c->>'format',
             'agreement', (c->>'agreement')::numeric, 'trailing', round(pv.agreement, 6),
             'decisions', (c->>'decisions')::bigint) AS finding
    FROM jsonb_array_elements(v_by_variant) c
    JOIN pv ON pv.variant = c->>'variant' AND pv.format = c->>'format'
    WHERE (c->>'decisions')::bigint >= 1000 AND (c->>'agreement') IS NOT NULL
      AND (c->>'agreement')::numeric < pv.agreement - 0.02
    UNION ALL
    SELECT jsonb_build_object('rule', 'unrecorded_graph', 'variant', c->>'variant', 'format', c->>'format',
             'decisions', (c->>'unrecorded')::bigint)
    FROM jsonb_array_elements(v_by_variant) c
    WHERE (c->>'unrecorded')::bigint > 0
    UNION ALL
    SELECT jsonb_build_object('rule', 'ood_rise', 'variant', c->>'variant',
             'share', (c->>'outside_domain_share')::numeric, 'trailing', round(po.ood, 6),
             'decisions', (c->>'decisions')::bigint)
    FROM jsonb_array_elements(v_outcomes) c
    JOIN po ON po.variant = c->>'variant'
    WHERE (c->>'decisions')::bigint >= 1000
      AND (c->>'outside_domain_share')::numeric > po.ood + 0.05
    UNION ALL
    SELECT jsonb_build_object('rule', 'unavailable_rise', 'variant', c->>'variant',
             'share', (c->>'unavailable_share')::numeric, 'trailing', round(po.unav, 6),
             'decisions', (c->>'decisions')::bigint)
    FROM jsonb_array_elements(v_outcomes) c
    JOIN po ON po.variant = c->>'variant'
    WHERE (c->>'decisions')::bigint >= 1000
      AND (c->>'unavailable_share')::numeric > 0.01
      AND (c->>'unavailable_share')::numeric > 2 * po.unav
    UNION ALL
    SELECT jsonb_build_object('rule', 'no_report_input')
    WHERE (v_totals->>'decisions')::bigint = 0
  )
  SELECT coalesce(jsonb_agg(finding), '[]'::jsonb) INTO v_findings FROM f;

  INSERT INTO public.horse_reference_agreement_daily AS r
    (day, generated_at, complete, totals, by_variant, divergence, policy_outcomes, second_looks, findings)
  VALUES (p_day, now(), v_complete, v_totals, v_by_variant, v_divergence, v_outcomes, v_second, v_findings)
  ON CONFLICT (day) DO UPDATE SET
    generated_at = EXCLUDED.generated_at,
    complete = EXCLUDED.complete,
    totals = EXCLUDED.totals,
    by_variant = EXCLUDED.by_variant,
    divergence = EXCLUDED.divergence,
    policy_outcomes = EXCLUDED.policy_outcomes,
    second_looks = EXCLUDED.second_looks,
    findings = EXCLUDED.findings;

  RETURN jsonb_build_object('day', p_day, 'complete', v_complete,
    'decisions', v_totals->'decisions', 'findings', jsonb_array_length(v_findings));
END;
$$;

REVOKE ALL ON FUNCTION public.fn_run_horse_reference_agreement(date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_run_horse_reference_agreement(date) TO service_role;

-- Reader for operators and agents (service role only; the report holds no
-- player data, but nothing in the client needs it).
CREATE OR REPLACE FUNCTION public.ca_horse_reference_agreement(p_days int DEFAULT 14)
RETURNS SETOF public.horse_reference_agreement_daily
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.horse_reference_agreement_daily
  WHERE day >= current_date - greatest(1, least(coalesce(p_days, 14), 120))
  ORDER BY day DESC;
$$;

REVOKE ALL ON FUNCTION public.ca_horse_reference_agreement(int) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ca_horse_reference_agreement(int) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- THE DAILY AUDIT READS RETIRED AND OUTCOME COUNTERS FOR WHAT THEY ARE
-- (2026-10-16)
--
-- fn_audit_layer_drift section 1 raised about 110 layer_went_silent warns on
-- 2026-10-15, none of them a layer that stopped executing: renamed or retired
-- reason codes, and reason, refusal and population counters. Retired keys are
-- now registered by the engine in horse_data_ledger (kind receipt, cadence
-- legacy_unused; HorseDataLedger.ts RETIRED_RECEIPTS) and reported as one info
-- line; reason, refusal and population counters are classified by the same
-- patterns section 2 has used since 2026-10-05 and reported as one info line.
-- Built on the installed body (md5(prosrc) 8e70a9a55f691a1bf2b1842530c97383,
-- identical to 20261005190000); section 2 is unchanged. Read-only, STABLE,
-- SECURITY DEFINER with the same grants as installed (postgres, service_role).
-- ═══════════════════════════════════════════════════════════════════════════

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
        'This layer was executing and is not any more. Trace the gate: a flag ' ||
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

REVOKE ALL ON FUNCTION public.fn_audit_layer_drift(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_layer_drift(date) TO service_role;

COMMIT;
