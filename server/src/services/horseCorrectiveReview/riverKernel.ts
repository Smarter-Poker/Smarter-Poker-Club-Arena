import type { AlternativeActionReference, CorrectiveAction } from './contract.js';
import { produceRiverCallFoldReference, type RiverReferenceInput } from './riverReference.js';
import { evidenceDigest } from './authority.js';
import { correctiveActionIsLegal } from './review.js';

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
    const from = r.alternatives.find((a) => same(a.choice, baseline));
    if (!from) return no('baseline_outside_reference_menu');
    const to = r.alternatives.find((a) => a !== from)!;
    const gain = to.lower - from.upper;
    if (gain <= 0.01) return { status: 'retained', reason: 'no_conservative_gain' };
    return {
      status: 'proposed',
      from: { ...from.choice },
      to: { ...to.choice },
      conditionalProbability: 0.05,
      modelGainLowerBb: gain,
      activationAllowed: false,
    };
  } catch {
    return no('reference_unreadable');
  }
}
