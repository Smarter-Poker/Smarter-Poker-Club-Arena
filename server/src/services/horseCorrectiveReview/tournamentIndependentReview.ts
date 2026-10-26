/** Numerical review only: benchmark settlement is independent of the producer
 * scorer. Source authentication, population custody and admission remain with
 * the existing owners; a reviewed number grants none of those capabilities. */
import type { TournamentRiverReferenceInput } from './tournamentRiverReference.js';
import { buildOriginalTournamentRiverDecision } from './tournamentRiverKernel.js';
import { independentlyPriceAcceptedTournamentRiver } from './tournamentAcceptedUtility.js';
import { evidenceDigest, sha256 } from './authority.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  tournamentKernelDefinitionFor,
} from './kernelTournamentDefinition.js';
import { correctiveDecisionDomain } from './domain.js';
const flags = {
  qualified: false as const,
  activationAllowed: false as const,
  sourceAuthenticated: false as const,
};
export type TournamentIndependentReviewResult = typeof flags &
  (
    | { status: 'unavailable'; reason: string }
    | {
        status: 'reviewed';
        reviewDigest: string;
        modelVersion: string;
        samplingContractDigest: string;
        rangeDigest: string;
        combinations: number;
      }
  );
// Each absolute share is in [0,1]; 32 weighted additions have roundoff far
// below 1e-12. Integer chip stacks and all identity commitments compare exactly.
const SHARE_TOLERANCE = 1e-12;
const share = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1;
const close = (a: number, b: number) => share(a) && share(b) && Math.abs(a - b) <= SHARE_TOLERANCE;
export function reviewTournamentModelNumerics(
  original: TournamentRiverReferenceInput['original']
): TournamentIndependentReviewResult {
  const no = (reason: string): TournamentIndependentReviewResult => ({
    ...flags,
    status: 'unavailable',
    reason,
  });
  try {
    const model = buildOriginalTournamentRiverDecision(original);
    if (model.status !== 'built') return no('tournament_numeric_model:' + model.reason);
    const definition = tournamentKernelDefinitionFor(
      model.prices.objective,
      correctiveDecisionDomain(original.snapshot.gameState)
    );
    if (!definition) return no('tournament_numeric_objective_mismatch');
    const prices = model.prices,
      range = model.input.range;
    const inputDigest = evidenceDigest(original.snapshot),
      readFrameDigest = evidenceDigest(original.readFrame),
      contextDigest = evidenceDigest(original.snapshot.gameState.tournament),
      rangeDigest = evidenceDigest(range);
    const contractDigest = evidenceDigest({
      version:
        definition.objective === TOURNAMENT_KERNEL_OBJECTIVE
          ? 'horse-wta-spin-public-finite-prior-contract-v1'
          : 'horse-closed-hu-ladder-public-finite-prior-contract-v1',
      model: definition.model,
      kernel: definition.kernel,
      rangeBasis: 'uniform_distinct_combos_from_original_hero_public_board_only',
      menuScope: 'fold_call_only_other_baseline_actions_unchanged',
      enumerationError: 0,
      modelCalibration: 'unqualified',
    });
    if (
      model.modelVersion !== definition.model.version ||
      !sha256(model.samplingSeedDigest) ||
      model.samplingContractDigest !== contractDigest ||
      model.kernelVersion !== definition.kernel.version ||
      model.input.version !==
        (definition.objective === TOURNAMENT_KERNEL_OBJECTIVE
          ? 'horse-wta-spin-river-reference-v1'
          : 'horse-closed-hu-ladder-river-reference-v1') ||
      evidenceDigest(model.input.original.snapshot) !== inputDigest ||
      evidenceDigest(model.input.original.readFrame) !== readFrameDigest ||
      model.input.rangeReadFrameDigest !== readFrameDigest ||
      prices.objective !== definition.kernel.objective ||
      prices.utilityUnit !== definition.kernel.utilityUnit ||
      prices.inputDigest !== inputDigest ||
      prices.readFrameDigest !== readFrameDigest ||
      prices.tournamentContextDigest !== contextDigest ||
      prices.rangeDigest !== rangeDigest ||
      prices.rangeReadFrameDigest !== readFrameDigest ||
      prices.conditionalOnDeclaredRange !== true
    )
      return no('tournament_numeric_identity_mismatch');
    if (
      !Array.isArray(range) ||
      range.length !== definition.model.samples ||
      !Array.isArray(prices.call.outcomes) ||
      prices.call.outcomes.length !== range.length
    )
      return no('tournament_numeric_population_bounds');
    let mean = 0;
    const seen = new Set<string>(),
      reviews: string[] = [];
    for (let i = 0; i < range.length; i++) {
      const combination = range[i]!,
        producer = prices.call.outcomes[i]!;
      if (
        combination.weight !== 1 ||
        !Array.isArray(combination.cards) ||
        combination.cards.length !== 2
      )
        return no('tournament_numeric_fixed_range_mismatch');
      const key = combination.cards
        .map((c) => c.rank + ':' + c.suit)
        .sort()
        .join('|');
      if (seen.has(key)) return no('tournament_numeric_duplicate_combination');
      seen.add(key);
      const independent = independentlyPriceAcceptedTournamentRiver({
        original,
        opponentCards: combination.cards,
      });
      if (independent.status !== 'priced')
        return no('tournament_numeric_independent:' + independent.reason);
      if (
        independent.objective !== prices.objective ||
        independent.utilityUnit !== prices.utilityUnit ||
        independent.inputDigest !== inputDigest ||
        independent.readFrameDigest !== readFrameDigest ||
        independent.tournamentContextDigest !== contextDigest ||
        independent.prizePoolCents !== prices.prizePoolCents ||
        !close(independent.fold.expectedPrizeShare, prices.fold.expectedPrizeShare) ||
        evidenceDigest(independent.fold.stacks) !== evidenceDigest(prices.fold.stacks) ||
        producer.weight !== combination.weight ||
        evidenceDigest(producer.cards) !== evidenceDigest(combination.cards) ||
        !close(independent.call.expectedPrizeShare, producer.expectedPrizeShare) ||
        evidenceDigest(independent.call.stacks) !== evidenceDigest(producer.stacks)
      )
        return no('tournament_numeric_settlement_disagreement');
      mean += independent.call.expectedPrizeShare * (combination.weight / range.length);
      reviews.push(
        evidenceDigest({ cards: combination.cards, weight: combination.weight, independent })
      );
    }
    if (!close(mean, prices.call.expectedPrizeShare))
      return no('tournament_numeric_weighted_mean_disagreement');
    return {
      ...flags,
      status: 'reviewed',
      modelVersion: model.modelVersion,
      samplingContractDigest: contractDigest,
      rangeDigest,
      combinations: range.length,
      reviewDigest: evidenceDigest({
        version: 'horse-tournament-independent-review-v1',
        objective: prices.objective,
        utilityUnit: prices.utilityUnit,
        inputDigest,
        readFrameDigest,
        contextDigest,
        rangeDigest,
        samplingSeedDigest: model.samplingSeedDigest,
        samplingContractDigest: contractDigest,
        prizePoolCents: prices.prizePoolCents,
        fold: prices.fold,
        callMean: mean,
        reviews,
        tolerance: SHARE_TOLERANCE,
      }),
    };
  } catch {
    return no('tournament_numeric_unreadable');
  }
}
