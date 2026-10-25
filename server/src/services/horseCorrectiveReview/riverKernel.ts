import type { AlternativeActionReference, CorrectiveAction } from './contract.js';
import {
  produceRiverCallFoldReference,
  type RiverReferenceInput,
  type RiverDecisionInput,
} from './riverReference.js';
import { evidenceDigest } from './authority.js';
import { correctiveActionIsLegal } from './review.js';
import { buildOriginalRiverDecision, RIVER_DECISION_MODEL } from './riverDecisionModel.js';

export const RIVER_CORRECTION_KERNEL = Object.freeze({
  version: 'river-call-fold-correction-v1',
  modelVersion: RIVER_DECISION_MODEL.version,
  conditionalProbability: 0.05 as const,
  minimumModelGainBb: 0.01,
});

export type RiverCorrectionProposal =
  | {
      status: 'proposed';
      from: CorrectiveAction;
      to: CorrectiveAction;
      conditionalProbability: 0.05;
      modelGainLowerBb: number;
      activationAllowed: false;
    }
  | { status: 'retained' | 'unavailable'; reason: string };
function proposalFromMenu(
  menu: AlternativeActionReference['alternatives'],
  baseline: CorrectiveAction
): RiverCorrectionProposal {
  const from = menu.find((a) => evidenceDigest(a.choice) === evidenceDigest(baseline));
  if (!from) return { status: 'unavailable', reason: 'baseline_outside_reference_menu' };
  const to = menu.find((a) => a !== from);
  if (!to) return { status: 'unavailable', reason: 'reference_menu_incomplete' };
  const gain = to.lower - from.upper;
  if (gain <= RIVER_CORRECTION_KERNEL.minimumModelGainBb)
    return { status: 'retained', reason: 'no_conservative_gain' };
  return {
    status: 'proposed',
    from: { ...from.choice },
    to: { ...to.choice },
    conditionalProbability: RIVER_CORRECTION_KERNEL.conditionalProbability,
    modelGainLowerBb: gain,
    activationAllowed: false,
  };
}
export type OriginalRiverCorrectionProposal = RiverCorrectionProposal & {
  modelVersion?: string;
  inputDigest?: string;
  readFrameDigest?: string;
  samplingContractDigest?: string;
};
/** Deterministic proposal only. The worker must separately admit authority,
 * sample the bounded change and recheck final action/effect acceptance. */
export function proposeOriginalRiverCorrection(
  original: RiverDecisionInput['original'],
  baseline: CorrectiveAction
): OriginalRiverCorrectionProposal {
  try {
    const model = buildOriginalRiverDecision(original);
    if (model.status !== 'built') return { status: 'unavailable', reason: model.reason };
    if (!correctiveActionIsLegal(model.input.original.snapshot, baseline))
      return { status: 'unavailable', reason: 'baseline_outside_reference_menu' };
    return {
      ...proposalFromMenu(model.prices.alternatives, baseline),
      modelVersion: model.modelVersion,
      inputDigest: model.prices.inputDigest,
      readFrameDigest: model.prices.readFrameDigest,
      samplingContractDigest: model.prices.samplingContractDigest,
    };
  } catch {
    return { status: 'unavailable', reason: 'original_policy_unreadable' };
  }
}

export function proposeRiverCallFoldCorrection(
  input: RiverReferenceInput,
  baseline: CorrectiveAction,
  reference: AlternativeActionReference
): RiverCorrectionProposal {
  const no = (reason: string): RiverCorrectionProposal => ({ status: 'unavailable', reason });
  try {
    const expected = produceRiverCallFoldReference(input);
    if (expected.status !== 'produced') return no(expected.reason);
    const e = expected.reference,
      r = reference;
    const same = (a: unknown, b: unknown) => evidenceDigest(a) === evidenceDigest(b);
    if (
      !r ||
      ![
        'version',
        'sourceId',
        'qualificationId',
        'evidenceClass',
        'domain',
        'samplingContractDigest',
        'producerDigest',
        'basis',
        'method',
        'causal',
        'complete',
        'informationSet',
        'utility',
        'binding',
      ].every((k) =>
        same(r[k as keyof AlternativeActionReference], e[k as keyof AlternativeActionReference])
      )
    )
      return no('reference_binding_or_producer_mismatch');
    const u = r.uncertainty;
    if (
      !u ||
      u.simultaneous !== true ||
      !Number.isFinite(u.familyWiseConfidence) ||
      u.familyWiseConfidence < 0.95 ||
      u.familyWiseConfidence > 1 ||
      !Number.isSafeInteger(u.independentSamples) ||
      u.independentSamples < 1
    )
      return no('reference_uncertainty_unqualified');
    if (
      !Array.isArray(r.alternatives) ||
      r.alternatives.length !== 2 ||
      !correctiveActionIsLegal(input.original.snapshot, baseline)
    )
      return no('reference_or_baseline_menu_invalid');
    const matches = e.alternatives.map((a) =>
      r.alternatives.filter((b) => same(a.choice, b.choice))
    );
    if (matches.some((rows) => rows.length !== 1)) return no('reference_menu_mismatch');
    for (let index = 0; index < matches.length; index++) {
      const a = matches[index]![0]!,
        truth = e.alternatives[index]!;
      if (
        a.mean !== truth.mean ||
        [a.lower, a.mean, a.upper].some((x) => !Number.isFinite(x) || Math.abs(x) > 1e12) ||
        a.lower > a.mean ||
        a.mean > a.upper
      )
        return no('reference_interval_invalid');
    }
    return proposalFromMenu(r.alternatives, baseline);
  } catch {
    return no('reference_unreadable');
  }
}
