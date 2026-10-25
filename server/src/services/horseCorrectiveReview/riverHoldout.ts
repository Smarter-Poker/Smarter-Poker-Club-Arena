import type { CorrectiveAction } from './contract.js';
import type { RiverReferenceInput } from './riverReference.js';
import { produceRiverCallFoldReference } from './riverReference.js';
import { proposeRiverCallFoldCorrection } from './riverKernel.js';
import { evidenceDigest } from './authority.js';
import { createHash } from 'node:crypto';

export interface RiverHoldoutCase {
  handKey: string;
  playedAt: string;
  input: RiverReferenceInput;
  baseline: CorrectiveAction;
  /** Internal full-policy measurement exclusion, included in the commitment. */
  retainedByPolicy?: string;
  /** Independent realized terminal utilities, never policy inputs. */
  oracle: { foldBb: number; callBb: number };
}
export interface RiverHoldoutPlan {
  sourceRelease: string;
  producerDigest: string;
  qualificationId: string;
  evidenceClass: RiverReferenceInput['evidenceClass'];
  declaredAt: string;
  holdoutStartsAt: string;
  holdoutEndsAt: string;
  selectionHandKeys: string[];
  minimumSamples: number;
  /** Predeclared absolute bound on a single hand's changed utility. */
  maximumAbsoluteDeltaBb: number;
  familyWiseAlpha: number;
  familySize: number;
}
export interface RiverHoldoutResult {
  status: 'measured' | 'unavailable';
  reasons: string[];
  samples: number;
  changed: number;
  meanGainBb: number | null;
  lowerGainBb: number | null;
  qualified: false;
  activationAllowed: false;
  measurementDigest?: string;
}
/** Measurement only. Source custody and oracle independence need separate
 * trusted review; caller-supplied JSON cannot grant either property. */
export function evaluateRiverHoldout(
  plan: RiverHoldoutPlan,
  rows: readonly RiverHoldoutCase[]
): RiverHoldoutResult {
  const no = (reason: string): RiverHoldoutResult => ({
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
    const instant = (s: string) =>
      typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
    if (
      !/^[a-f0-9]{40}$/.test(plan.sourceRelease) ||
      !/^[a-f0-9]{64}$/.test(plan.producerDigest) ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(plan.qualificationId) ||
      !['synthetic_fixture', 'reviewed_reference'].includes(plan.evidenceClass) ||
      !instant(plan.declaredAt) ||
      !instant(plan.holdoutStartsAt) ||
      !instant(plan.holdoutEndsAt) ||
      plan.declaredAt >= plan.holdoutStartsAt ||
      plan.holdoutStartsAt >= plan.holdoutEndsAt ||
      !Number.isSafeInteger(plan.minimumSamples) ||
      plan.minimumSamples < 2 ||
      !Number.isFinite(plan.maximumAbsoluteDeltaBb) ||
      plan.maximumAbsoluteDeltaBb <= 0 ||
      plan.maximumAbsoluteDeltaBb > 1e6 ||
      !Number.isFinite(plan.familyWiseAlpha) ||
      plan.familyWiseAlpha <= 0 ||
      plan.familyWiseAlpha > 0.05 ||
      !Number.isSafeInteger(plan.familySize) ||
      plan.familySize < 1 ||
      plan.familySize > 1e6 ||
      !Array.isArray(plan.selectionHandKeys) ||
      !plan.selectionHandKeys.length ||
      plan.selectionHandKeys.some((k) => typeof k !== 'string' || !/^[a-f0-9]{64}$/.test(k)) ||
      new Set(plan.selectionHandKeys).size !== plan.selectionHandKeys.length
    )
      return no('invalid_predeclared_plan');
    if (!Array.isArray(rows) || rows.length < plan.minimumSamples || rows.length > 100000)
      return no('holdout_sample_count_invalid');
    const seen = new Set(plan.selectionHandKeys),
      decisions = new Set<string>(),
      hands = new Set<string>();
    const measurement = createHash('sha256')
      .update('horse-river-holdout-v1\0')
      .update(evidenceDigest(plan));
    let sum = 0,
      changed = 0;
    for (const row of rows) {
      if (
        typeof row.handKey !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.handKey) ||
        seen.has(row.handKey)
      )
        return no('holdout_selection_overlap_or_duplicate');
      seen.add(row.handKey);
      const binding = row.input.binding;
      if (decisions.has(binding.decisionDigest) || hands.has(binding.acceptedHandDigest))
        return no('holdout_source_reused');
      decisions.add(binding.decisionDigest);
      hands.add(binding.acceptedHandDigest);
      if (
        !instant(row.playedAt) ||
        row.playedAt < plan.holdoutStartsAt ||
        row.playedAt >= plan.holdoutEndsAt ||
        row.input.binding.sourceRelease !== plan.sourceRelease ||
        row.input.producerDigest !== plan.producerDigest ||
        row.input.qualificationId !== plan.qualificationId ||
        row.input.evidenceClass !== plan.evidenceClass
      )
        return no('holdout_source_or_window_mismatch');
      if (
        !Number.isFinite(row.oracle.foldBb) ||
        row.oracle.foldBb !== 0 ||
        !Number.isFinite(row.oracle.callBb) ||
        Math.abs(row.oracle.callBb) > 1e12
      )
        return no('holdout_oracle_invalid');
      const reference = produceRiverCallFoldReference(row.input);
      if (reference.status !== 'produced') return no(`holdout_reference:${reference.reason}`);
      const proposal = row.retainedByPolicy
        ? { status: 'retained' as const, reason: row.retainedByPolicy }
        : proposeRiverCallFoldCorrection(row.input, row.baseline, reference.reference);
      if (proposal.status === 'unavailable') return no(`holdout_policy:${proposal.reason}`);
      let delta = 0;
      if (proposal.status === 'proposed') {
        const utility = (action: CorrectiveAction) =>
          action.action === 'fold' ? row.oracle.foldBb : row.oracle.callBb;
        delta = proposal.conditionalProbability * (utility(proposal.to) - utility(proposal.from));
        changed++;
      }
      if (!Number.isFinite(delta) || Math.abs(delta) > plan.maximumAbsoluteDeltaBb)
        return no('holdout_predeclared_bound_exceeded');
      sum += delta;
      // Stream bounded record commitments rather than serializing the entire
      // population under the unrelated 512 KiB single-journal-record limit.
      measurement.update('\n').update(
        evidenceDigest({
          handKey: row.handKey,
          playedAt: row.playedAt,
          reference: reference.reference,
          baseline: row.baseline,
          oracle: row.oracle,
          proposal,
          delta,
        })
      );
    }
    const mean = sum / rows.length;
    // One-sided Hoeffding, union bounded across the predeclared family.
    // Every hand counts, including those for which the kernel retains baseline.
    const radius =
      plan.maximumAbsoluteDeltaBb *
      Math.sqrt((2 * Math.log(plan.familySize / plan.familyWiseAlpha)) / rows.length);
    return {
      status: 'measured',
      reasons: [],
      samples: rows.length,
      changed,
      meanGainBb: mean,
      lowerGainBb: mean - radius,
      qualified: false,
      activationAllowed: false,
      measurementDigest: measurement.digest('hex'),
    };
  } catch {
    return no('holdout_unreadable');
  }
}
