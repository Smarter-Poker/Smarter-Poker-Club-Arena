import { correctiveBaselineRefusal } from './kernelEligibility.js';
import type { HorseDecision } from '../../types.js';
import type { RiverDecisionInput } from './riverReference.js';
import type { CorrectiveAction } from './contract.js';
import type { HorseAuthorityReceipt } from '../../engine/HorseQualifiedAuthority.js';
import { correctiveDecisionDomain, correctiveDomainKey } from './domain.js';
import {
  isValidatedCorrectiveKernelCatalog,
  correctiveKernelCatalogDigest,
  type CorrectiveKernelCatalog,
} from './kernelCatalog.js';
import { proposeOriginalRiverCorrection, RIVER_CORRECTION_KERNEL } from './riverKernel.js';
export interface CorrectiveLiveKernelReceipt {
  version: 'horse-corrective-live-kernel-v1';
  domain: string;
  catalogDigest: string;
  sourceSha: string;
  policyDigest: string;
  baselineSelectionsDigest: string;
  inputDigest: string;
  readFrameDigest: string;
  samplingContractDigest: string;
  conditionalProbability: 0.05;
  modelGainLowerBb: number;
  baseline: CorrectiveAction;
  proposed: CorrectiveAction;
  selected: CorrectiveAction;
  applied: boolean;
  reason: 'sampled' | 'not_sampled' | 'illegal_candidate' | 'withdrawn_before_acceptance';
  authority?: HorseAuthorityReceipt;
  baselineAuthorities?: Partial<
    Record<'phase10' | 'phase11' | 'phase12' | 'phase13', HorseAuthorityReceipt>
  >;
}
/** Pure decision-time consumer of an already validated functional catalog.
 * The worker owns S4 admission before invoking this function and checks it
 * again at acceptance/effect commit. No key, file, network or hidden outcome
 * is consulted here. Absent/unusable catalogs preserve the baseline and RNG. */
export function evaluateAdmittedRiverKernel(
  catalog: Readonly<CorrectiveKernelCatalog> | null,
  original: RiverDecisionInput['original'],
  baseline: HorseDecision,
  draw: () => number
): { decision: HorseDecision; receipt: CorrectiveLiveKernelReceipt | null } {
  const unchanged = () => ({ decision: baseline, receipt: null });
  if (!isValidatedCorrectiveKernelCatalog(catalog)) return unchanged();
  if (correctiveBaselineRefusal(original, baseline)) return unchanged();
  const domain = correctiveDecisionDomain(original?.snapshot?.gameState);
  if (!domain || correctiveDomainKey(domain) !== correctiveDomainKey(catalog.domain))
    return unchanged();
  // An advertised all-in remains outside this declared fold/call family.
  if (baseline.action !== 'fold' && baseline.action !== 'call') return unchanged();
  const amount =
    baseline.action === 'fold'
      ? 0
      : (baseline.amount ??
        Math.min(original.snapshot.player.stack, Number(original.snapshot.gameState.toCall)));
  const choice: CorrectiveAction = { action: baseline.action, amount };
  const proposal = proposeOriginalRiverCorrection(original, choice);
  if (
    proposal.status !== 'proposed' ||
    !proposal.inputDigest ||
    !proposal.readFrameDigest ||
    !proposal.samplingContractDigest
  )
    return unchanged();
  let sample: number;
  try {
    sample = draw();
  } catch {
    return unchanged();
  }
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) return unchanged();
  const applied = sample < proposal.conditionalProbability;
  const receipt: CorrectiveLiveKernelReceipt = {
    version: 'horse-corrective-live-kernel-v1',
    domain: correctiveDomainKey(domain),
    catalogDigest: correctiveKernelCatalogDigest(catalog),
    sourceSha: catalog.sourceRelease,
    policyDigest: catalog.policyDigest,
    baselineSelectionsDigest: catalog.baselineSelectionsDigest,
    inputDigest: proposal.inputDigest,
    readFrameDigest: proposal.readFrameDigest,
    samplingContractDigest: proposal.samplingContractDigest,
    conditionalProbability: RIVER_CORRECTION_KERNEL.conditionalProbability,
    modelGainLowerBb: proposal.modelGainLowerBb,
    baseline: choice,
    proposed: { ...proposal.to },
    selected: applied ? { ...proposal.to } : { ...choice },
    applied,
    reason: applied ? 'sampled' : 'not_sampled',
  };
  return {
    decision: applied
      ? { ...baseline, action: proposal.to.action, amount: proposal.to.amount }
      : baseline,
    receipt,
  };
}

export type CorrectiveKernelEvaluator = (
  baseline: HorseDecision
) => ReturnType<typeof evaluateAdmittedRiverKernel>;
const evaluators = new WeakSet<object>();
/** Worker-local capability. Never serialized in a request or accepted from IPC.
 * Both original-state capture and current S4 verdict are owned by the worker. */
export function createCorrectiveKernelEvaluator(input: {
  catalog: Readonly<CorrectiveKernelCatalog> | null;
  original: () => RiverDecisionInput['original'];
  stillUsable: () => boolean;
  draw: () => number;
}): CorrectiveKernelEvaluator | null {
  if (!isValidatedCorrectiveKernelCatalog(input.catalog)) return null;
  const catalog = input.catalog,
    original = input.original,
    stillUsable = input.stillUsable,
    draw = input.draw;
  const evaluator: CorrectiveKernelEvaluator = (baseline) => {
    try {
      if (!stillUsable()) return { decision: baseline, receipt: null };
      const result = evaluateAdmittedRiverKernel(catalog, original(), baseline, draw);
      // A withdrawal during a future injected calculation cannot leak a change.
      return stillUsable() ? result : { decision: baseline, receipt: null };
    } catch {
      return { decision: baseline, receipt: null };
    }
  };
  evaluators.add(evaluator);
  evaluatorIdentities.set(
    evaluator,
    Object.freeze({
      domain: correctiveDomainKey(catalog.domain),
      catalogDigest: correctiveKernelCatalogDigest(catalog),
    })
  );
  return evaluator;
}
export function runCorrectiveKernelEvaluator(
  evaluator: unknown,
  baseline: HorseDecision
): ReturnType<typeof evaluateAdmittedRiverKernel> {
  return typeof evaluator === 'function' && evaluators.has(evaluator)
    ? (evaluator as CorrectiveKernelEvaluator)(baseline)
    : { decision: baseline, receipt: null };
}

const evaluatorIdentities = new WeakMap<
  object,
  Readonly<{ domain: string; catalogDigest: string }>
>();
export function correctiveKernelEvaluatorIdentity(
  value: unknown
): Readonly<{ domain: string; catalogDigest: string }> | null {
  return typeof value === 'function' ? (evaluatorIdentities.get(value) ?? null) : null;
}
