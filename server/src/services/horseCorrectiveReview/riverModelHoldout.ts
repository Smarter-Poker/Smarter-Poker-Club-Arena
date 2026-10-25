import type { RiverHoldoutPlan, RiverHoldoutCase, RiverHoldoutResult } from './riverHoldout.js';
import { evaluateRiverHoldout } from './riverHoldout.js';
import { buildOriginalRiverDecision, RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { RIVER_CORRECTION_KERNEL } from './riverKernel.js';
export interface RiverModelHoldoutPlan extends RiverHoldoutPlan {
  modelVersion: string;
  policyVersion: string;
}
export interface RiverModelHoldoutResult extends RiverHoldoutResult {
  modelVersion: string;
  policyVersion: string;
}
/** Evaluate the fixed original-state model, not retrospective ranges selected
 * by a producer after seeing the outcome. Oracle outcomes never enter it. */
export function evaluateRiverDecisionModelHoldout(
  plan: RiverModelHoldoutPlan,
  rows: readonly RiverHoldoutCase[]
): RiverModelHoldoutResult {
  const identity = {
    modelVersion: RIVER_DECISION_MODEL.version,
    policyVersion: RIVER_CORRECTION_KERNEL.version,
  };
  const no = (reason: string): RiverModelHoldoutResult => ({
    ...identity,
    status: 'unavailable',
    reasons: [reason],
    samples: 0,
    changed: 0,
    meanGainBb: null,
    lowerGainBb: null,
    qualified: false,
    activationAllowed: false,
  });
  try {
    if (
      plan.modelVersion !== RIVER_DECISION_MODEL.version ||
      plan.policyVersion !== RIVER_CORRECTION_KERNEL.version
    )
      return no('holdout_model_version_mismatch');
    if (!Array.isArray(rows) || rows.length > 10000) return no('holdout_model_population_bounds');
    const actual: RiverHoldoutCase[] = [];
    for (const row of rows) {
      const model = buildOriginalRiverDecision(row.input.original);
      if (model.status !== 'built') return no(`holdout_model:${model.reason}`);
      actual.push({
        ...row,
        input: { ...row.input, ...model.input, finalRake: model.prices.finalRake },
      });
    }
    // The extra modelVersion field remains in the canonical plan commitment.
    return { ...evaluateRiverHoldout(plan, actual), ...identity };
  } catch {
    return no('holdout_model_unreadable');
  }
}
