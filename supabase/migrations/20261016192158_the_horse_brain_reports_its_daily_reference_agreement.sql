-- 20261016192158_the_horse_brain_reports_its_daily_reference_agreement.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY: Horse Brain Phase 15 daily reference-agreement
-- report (table, writer function, reader function). All DDL in ONE
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

COMMIT;
