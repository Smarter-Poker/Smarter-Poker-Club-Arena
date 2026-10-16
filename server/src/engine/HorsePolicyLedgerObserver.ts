/**
 * PHASE 15: THE POLICY LEDGER IS WATCHED, AND IT REPORTS ITS REFERENCE
 * AGREEMENT (2026-10-16).
 *
 * The playbook's Phase 15 asks for "out-of-domain detection ... component/
 * fleet liveness and daily reference-agreement reporting" and proves it with
 * "OOD and silence alarms" (docs/horse-brain-round1-playbook.md, Phase 15).
 * The brain already counted its policy outcome per variant
 * (`phase15_policy_<variant>_<outcome>`, HorseLogic) and its graph nodes, but
 * only into the daily `horse_brain_telemetry` table: no alert rule can read a
 * table, and nothing compared the executed policy action with the reference.
 *
 * This observer runs on the main thread for every FAST decision the worker
 * returns, after the receipt has been validated, and does three bounded
 * things. It reads the decision; it never changes it.
 *
 *   1. `poker_horse_policy_decisions_total{variant,outcome}`: the policy
 *      outcome the registry reconciled (reference, disabled, computed,
 *      outside_domain, unavailable), `shadow_receipt_dropped` when the client
 *      dropped a shadow-only receipt (and its ownership record) whose strict
 *      binding failed, or `unregistered` when the decision carries no
 *      ownership receipt for any other reason. The OOD and silence alarms read it
 *      (infra/monitoring/alert-rules.yml, group `horse-brain-phase15`).
 *   2. `poker_horse_reference_agreement_total{variant,format,agreement}`:
 *      whether the final policy action equals the action the graph's
 *      `reference` node produced: `exact` (action and amount), `action`
 *      (same action, other amount), `differ`, or `unrecorded` (no sealed
 *      graph).
 *   3. The same agreement, and for a difference the first graph node that
 *      moved the action away from the reference, into the daily brain
 *      telemetry (`phase15_reference_agreement_<variant>_<format>_<agreement>`,
 *      `phase15_reference_divergence_<variant>_<node>`), which the daily
 *      reference-agreement report reads (fn_run_horse_reference_agreement).
 *
 * Every label is drawn from a closed set: an unregistered variant string is
 * counted as `other`, never as itself. DEEP second looks re-decide the same
 * turn and are not counted, so each FAST decision counts once.
 */
import type { HorseDecision } from '../types.js';
import { noteFire } from './BrainTelemetry.js';
import { HORSE_POLICY_ORDER, type HorsePolicyGraphReceipt } from './HorsePolicyGraph.js';
import {
  HORSE_POLICY_LEDGER_FORMATS,
  HORSE_POLICY_LEDGER_OUTCOMES,
  HORSE_POLICY_LEDGER_VARIANTS,
  horsePolicyDecisionsTotal,
  horseReferenceAgreementTotal,
} from '../observability/engineInstruments.js';

export type HorseReferenceAgreement = 'exact' | 'action' | 'differ' | 'unrecorded';
type LedgerVariant = (typeof HORSE_POLICY_LEDGER_VARIANTS)[number];
type LedgerOutcome = (typeof HORSE_POLICY_LEDGER_OUTCOMES)[number];
type LedgerFormat = (typeof HORSE_POLICY_LEDGER_FORMATS)[number];

const VARIANTS: ReadonlySet<string> = new Set(HORSE_POLICY_LEDGER_VARIANTS);
const OUTCOMES: ReadonlySet<string> = new Set(HORSE_POLICY_LEDGER_OUTCOMES);

export interface HorsePolicyLedgerObservation {
  variant: LedgerVariant;
  format: LedgerFormat;
  outcome: LedgerOutcome;
  agreement: HorseReferenceAgreement;
  /** The first node whose transition changed the action, for `action`/`differ`. */
  divergedAt: string | null;
}

/**
 * What the client already knows about the receipt before the observer reads
 * it. `ownershipDroppedWithShadowReceipt`: the client removed the decision's
 * ownership record together with a shadow-only receipt whose strict binding
 * failed (client.ts, `phaseN_shadow_receipt_binding_dropped`). Its owner was
 * known; it is not an unregistered decision.
 */
export interface HorsePolicyLedgerContext {
  ownershipDroppedWithShadowReceipt?: boolean;
}

/** Pure: classify one validated FAST decision. Never throws. */
export function classifyHorsePolicyDecision(
  gameState: { gameVariant?: unknown; gameMode?: unknown } | null | undefined,
  decision: HorseDecision | null | undefined,
  context: HorsePolicyLedgerContext = {}
): HorsePolicyLedgerObservation {
  const rawVariant = gameState?.gameVariant ?? 'nlh';
  const variant = (
    typeof rawVariant === 'string' && VARIANTS.has(rawVariant) ? rawVariant : 'other'
  ) as LedgerVariant;
  const format: LedgerFormat = gameState?.gameMode === 'cash' ? 'cash' : 'tournament';
  const ownership = decision?.policyOwnership as { outcome?: unknown } | undefined;
  const outcome = (
    ownership &&
    typeof ownership.outcome === 'string' &&
    ownership.outcome !== 'shadow_receipt_dropped' &&
    OUTCOMES.has(ownership.outcome)
      ? ownership.outcome
      : !ownership && context.ownershipDroppedWithShadowReceipt === true
        ? 'shadow_receipt_dropped'
        : 'unregistered'
  ) as LedgerOutcome;
  const graph = decision?.policyGraph as HorsePolicyGraphReceipt | undefined;
  const transitions = Array.isArray(graph?.transitions) ? graph!.transitions : [];
  const reference = transitions[0]?.node === 'reference' ? transitions[0].after : null;
  const final = graph?.finalAction ?? null;
  if (!reference || !final || transitions.length !== HORSE_POLICY_ORDER.length)
    return { variant, format, outcome, agreement: 'unrecorded', divergedAt: null };
  const agreement: HorseReferenceAgreement =
    final.action !== reference.action
      ? 'differ'
      : (final.amount ?? null) === (reference.amount ?? null)
        ? 'exact'
        : 'action';
  const divergedAt =
    agreement === 'exact' ? null : (transitions.find((t, i) => i > 0 && t.changed)?.node ?? null);
  return { variant, format, outcome, agreement, divergedAt };
}

/** Count one FAST decision. Telemetry must never break the decision lane. */
export function observeHorsePolicyDecision(
  gameState: { gameVariant?: unknown; gameMode?: unknown } | null | undefined,
  decision: HorseDecision | null | undefined,
  context: HorsePolicyLedgerContext = {}
): HorsePolicyLedgerObservation | null {
  try {
    const o = classifyHorsePolicyDecision(gameState, decision, context);
    horsePolicyDecisionsTotal.inc(1, { variant: o.variant, outcome: o.outcome });
    horseReferenceAgreementTotal.inc(1, {
      variant: o.variant,
      format: o.format,
      agreement: o.agreement,
    });
    noteFire(`phase15_reference_agreement_${o.variant}_${o.format}_${o.agreement}`);
    if (o.divergedAt) noteFire(`phase15_reference_divergence_${o.variant}_${o.divergedAt}`);
    return o;
  } catch {
    return null;
  }
}
