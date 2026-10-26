/** Offline numerical cross-check only. This module deliberately does not
 * authenticate acquisition, certify a locked population, replay the baseline,
 * establish rollback authority, sign a release or return qualified:true. */
import { createHash } from 'node:crypto';
import { buildOriginalRiverDecision, RIVER_DECISION_MODEL } from './riverDecisionModel.js';
import { RIVER_CORRECTION_KERNEL } from './kernelDefinition.js';
import { produceRiverCallFoldReference, type RiverReferenceInput } from './riverReference.js';
import { reviewRiverEnumeration } from './riverIndependentReview.js';
import { evidenceDigest } from './authority.js';

export const CORRECTIVE_KERNEL_NUMERICAL_REVIEW_VERSION =
  'horse-corrective-kernel-numerical-review-v1';
export const CORRECTIVE_KERNEL_NUMERICAL_MAX_CASES = 10000;
export interface CorrectiveKernelNumericalReview {
  readonly version: typeof CORRECTIVE_KERNEL_NUMERICAL_REVIEW_VERSION;
  readonly modelVersion: string;
  readonly kernelVersion: string;
  readonly status: 'numerically_consistent' | 'unavailable' | 'mismatch';
  readonly reason: string;
  readonly checkedCases: number;
  readonly checkedCombinations: number;
  readonly reviewDigest: string | null;
  readonly qualified: false;
  readonly sourceReadVerified: false;
  readonly completePopulation: false;
  readonly activationAllowed: false;
}

/** Rebuild the original-only fixed model for every case. Supplied retrospective
 * ranges/quotes never supply the answer. Each reference is checked by the
 * independent benchmark scorer, contribution layers and integer fee allocator.
 * A partial batch has no review digest; only an entirely consistent bounded
 * batch commits its ordered reference/review digests into the result. */
export function reviewCorrectiveKernelNumerics(
  rows: readonly RiverReferenceInput[]
): CorrectiveKernelNumericalReview {
  let checkedCases = 0,
    checkedCombinations = 0;
  const result = (
    status: CorrectiveKernelNumericalReview['status'],
    reason: string,
    reviewDigest: string | null = null
  ): CorrectiveKernelNumericalReview =>
    Object.freeze({
      version: CORRECTIVE_KERNEL_NUMERICAL_REVIEW_VERSION,
      modelVersion: RIVER_DECISION_MODEL.version,
      kernelVersion: RIVER_CORRECTION_KERNEL.version,
      status,
      reason,
      checkedCases,
      checkedCombinations,
      reviewDigest,
      qualified: false,
      sourceReadVerified: false,
      completePopulation: false,
      activationAllowed: false,
    });
  if (
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > CORRECTIVE_KERNEL_NUMERICAL_MAX_CASES
  )
    return result('unavailable', 'numerical_batch_bounds');
  const decisions = new Set<string>(),
    acceptedHands = new Set<string>();
  const digest = createHash('sha256')
    .update(CORRECTIVE_KERNEL_NUMERICAL_REVIEW_VERSION + '\0')
    .update(RIVER_DECISION_MODEL.version + '\0' + RIVER_CORRECTION_KERNEL.version + '\0');
  try {
    for (const row of rows) {
      const model = buildOriginalRiverDecision(row?.original);
      if (model.status !== 'built')
        return result('unavailable', 'numerical_original_model_unavailable');
      const input: RiverReferenceInput = {
        ...row,
        ...model.input,
        finalRake: model.prices.finalRake,
      };
      const produced = produceRiverCallFoldReference(input);
      if (produced.status !== 'produced')
        return result('unavailable', 'numerical_reference_unavailable');
      if (
        decisions.has(input.binding.decisionDigest) ||
        acceptedHands.has(input.binding.acceptedHandDigest)
      )
        return result('unavailable', 'numerical_source_reused');
      decisions.add(input.binding.decisionDigest);
      acceptedHands.add(input.binding.acceptedHandDigest);
      const independent = reviewRiverEnumeration(input, produced.reference);
      if (independent.status !== 'numerically_consistent')
        return result(
          independent.status === 'mismatch' ? 'mismatch' : 'unavailable',
          'numerical_independent_review_refused'
        );
      if (
        independent.referenceDigest !== evidenceDigest(produced.reference) ||
        independent.checkedCombinations !== model.input.range.length
      )
        return result('unavailable', 'numerical_independent_review_incomplete');
      checkedCases++;
      checkedCombinations += independent.checkedCombinations;
      digest.update('\n').update(
        evidenceDigest({
          referenceDigest: independent.referenceDigest,
          independentReview: independent,
        })
      );
    }
    return result(
      'numerically_consistent',
      'all_fixed_model_references_checked',
      digest.digest('hex')
    );
  } catch {
    return result('unavailable', 'numerical_input_unreadable');
  }
}
