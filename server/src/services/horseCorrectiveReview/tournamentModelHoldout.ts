/** Measurement adapter for the existing full-population pipeline. All supplied
 * metadata/oracles require separate authenticated source review. This pure
 * calculation never qualifies a population, issues approval or activates play. */
import { createHash } from 'node:crypto';
import type { HorseDecision } from '../../types.js';
import type { CorrectiveReferenceDomain } from './domain.js';
import { correctiveDomainIsValid, CORRECTIVE_DOMAIN_KEYS } from './domain.js';
import { evidenceDigest, sha256 } from './authority.js';
import {
  buildOriginalTournamentRiverDecision,
  proposeOriginalTournamentRiverCorrection,
} from './tournamentRiverKernel.js';
import type { TournamentRiverReferenceInput } from './tournamentRiverReference.js';
import {
  TOURNAMENT_KERNEL_OBJECTIVE,
  TOURNAMENT_KERNEL_UTILITY_UNIT,
  tournamentKernelDefinitionFor,
  type TournamentKernelObjective,
  TOURNAMENT_RIVER_CORRECTION_KERNEL,
} from './kernelTournamentDefinition.js';
import { measurePairedHoldoutDeltas } from './pairedHoldoutMeasurement.js';
export interface TournamentModelHoldoutPlan {
  objective: TournamentKernelObjective;
  utilityUnit: typeof TOURNAMENT_KERNEL_UTILITY_UNIT;
  domain: CorrectiveReferenceDomain;
  populationBasis: 'accepted-commit-and-immutable-played-v1';
  sourceRelease: string;
  producerDigest: string;
  qualificationId: string;
  evidenceClass: 'synthetic_fixture' | 'reviewed_reference';
  declaredAt: string;
  holdoutStartsAt: string;
  holdoutEndsAt: string;
  selectionHandKeys: string[];
  minimumSamples: number;
  maximumAbsoluteDelta: number;
  familyWiseAlpha: number;
  familySize: number;
  modelVersion: string;
  policyVersion: string;
}
export interface TournamentModelHoldoutCase {
  handKey: string;
  playedAt: string;
  sourceRelease: string;
  producerDigest: string;
  qualificationId: string;
  evidenceClass: TournamentModelHoldoutPlan['evidenceClass'];
  decisionDigest: string;
  acceptedHandDigest: string;
  original: TournamentRiverReferenceInput['original'];
  baselineDecision: HorseDecision;
  oracle: { fold: number; call: number };
}
export type TournamentModelHoldoutResult = {
  objective: TournamentKernelObjective;
  utilityUnit: typeof TOURNAMENT_KERNEL_UTILITY_UNIT;
  modelVersion: string;
  policyVersion: string;
  qualified: false;
  activationAllowed: false;
} & (
  | {
      status: 'unavailable';
      reasons: string[];
      samples: 0;
      changed: 0;
      meanGain: null;
      lowerGain: null;
    }
  | {
      status: 'measured';
      reasons: [];
      samples: number;
      changed: number;
      meanGain: number;
      lowerGain: number;
      measurementDigest: string;
    }
);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const PLAN_KEYS = [
  'objective',
  'utilityUnit',
  'domain',
  'populationBasis',
  'sourceRelease',
  'producerDigest',
  'qualificationId',
  'evidenceClass',
  'declaredAt',
  'holdoutStartsAt',
  'holdoutEndsAt',
  'selectionHandKeys',
  'minimumSamples',
  'maximumAbsoluteDelta',
  'familyWiseAlpha',
  'familySize',
  'modelVersion',
  'policyVersion',
];
const ROW_KEYS = [
  'handKey',
  'playedAt',
  'sourceRelease',
  'producerDigest',
  'qualificationId',
  'evidenceClass',
  'decisionDigest',
  'acceptedHandDigest',
  'original',
  'baselineDecision',
  'oracle',
];
const instant = (s: unknown): s is string =>
  typeof s === 'string' &&
  s.length <= 64 &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString() === s;
export function tournamentModelHoldoutPlanIsValid(
  value: unknown
): value is TournamentModelHoldoutPlan {
  try {
    if (!exact(value, PLAN_KEYS)) return false;
    const plan = value as unknown as TournamentModelHoldoutPlan;
    const definition = tournamentKernelDefinitionFor(plan.objective, plan.domain);
    return !(
      !exact(plan, PLAN_KEYS) ||
      !definition ||
      plan.utilityUnit !== TOURNAMENT_KERNEL_UTILITY_UNIT ||
      plan.modelVersion !== definition.model.version ||
      plan.policyVersion !== definition.kernel.version ||
      !correctiveDomainIsValid(plan.domain) ||
      plan.populationBasis !== 'accepted-commit-and-immutable-played-v1' ||
      typeof plan.sourceRelease !== 'string' ||
      !/^[a-f0-9]{40}$/.test(plan.sourceRelease) ||
      !sha256(plan.producerDigest) ||
      typeof plan.qualificationId !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(plan.qualificationId) ||
      !['synthetic_fixture', 'reviewed_reference'].includes(plan.evidenceClass) ||
      !instant(plan.declaredAt) ||
      !instant(plan.holdoutStartsAt) ||
      !instant(plan.holdoutEndsAt) ||
      plan.declaredAt >= plan.holdoutStartsAt ||
      plan.holdoutStartsAt >= plan.holdoutEndsAt ||
      !Number.isSafeInteger(plan.minimumSamples) ||
      plan.minimumSamples < 2 ||
      plan.minimumSamples > 10000 ||
      plan.maximumAbsoluteDelta !== TOURNAMENT_RIVER_CORRECTION_KERNEL.conditionalProbability ||
      !Number.isFinite(plan.familyWiseAlpha) ||
      plan.familyWiseAlpha <= 0 ||
      plan.familyWiseAlpha > 0.05 ||
      !Number.isSafeInteger(plan.familySize) ||
      plan.familySize < CORRECTIVE_DOMAIN_KEYS.length ||
      plan.familySize > 1e6 ||
      !Array.isArray(plan.selectionHandKeys) ||
      !plan.selectionHandKeys.length ||
      plan.selectionHandKeys.length > 10000 ||
      plan.selectionHandKeys.some((k) => !sha256(k)) ||
      new Set(plan.selectionHandKeys).size !== plan.selectionHandKeys.length
    );
  } catch {
    return false;
  }
}
export function evaluateTournamentDecisionModelHoldout(
  plan: TournamentModelHoldoutPlan,
  rows: readonly TournamentModelHoldoutCase[]
): TournamentModelHoldoutResult {
  const definition = tournamentKernelDefinitionFor(plan?.objective, plan?.domain);
  const identity = {
    objective: definition?.objective ?? TOURNAMENT_KERNEL_OBJECTIVE,
    utilityUnit: TOURNAMENT_KERNEL_UTILITY_UNIT,
    modelVersion: definition?.model.version ?? 'unavailable',
    policyVersion: definition?.kernel.version ?? 'unavailable',
    qualified: false as const,
    activationAllowed: false as const,
  };
  const no = (reason: string): TournamentModelHoldoutResult => ({
    ...identity,
    status: 'unavailable',
    reasons: [reason],
    samples: 0,
    changed: 0,
    meanGain: null,
    lowerGain: null,
  });
  try {
    if (!definition || !tournamentModelHoldoutPlanIsValid(plan))
      return no('invalid_predeclared_tournament_plan');
    if (!Array.isArray(rows) || rows.length < plan.minimumSamples || rows.length > 10000)
      return no('tournament_holdout_sample_count_invalid');
    const hands = new Set(plan.selectionHandKeys),
      decisions = new Set<string>(),
      accepted = new Set<string>(),
      deltas: number[] = [];
    const measurement = createHash('sha256')
      .update('horse-tournament-model-holdout-v1\0')
      .update(evidenceDigest(plan));
    let changed = 0;
    // Array.isArray guards runtime callers but otherwise widens iteration to
    // any[]. Restore the declared row type; the exact-key and field validators
    // below still establish every runtime requirement before model use.
    const typedRows: readonly TournamentModelHoldoutCase[] = rows;
    for (const row of typedRows) {
      if (
        !exact(row, ROW_KEYS) ||
        !sha256(row.handKey) ||
        hands.has(row.handKey) ||
        !sha256(row.decisionDigest) ||
        !sha256(row.acceptedHandDigest) ||
        decisions.has(row.decisionDigest) ||
        accepted.has(row.acceptedHandDigest)
      )
        return no('tournament_holdout_source_overlap_or_duplicate');
      hands.add(row.handKey);
      decisions.add(row.decisionDigest);
      accepted.add(row.acceptedHandDigest);
      if (
        !instant(row.playedAt) ||
        row.playedAt < plan.holdoutStartsAt ||
        row.playedAt >= plan.holdoutEndsAt ||
        row.sourceRelease !== plan.sourceRelease ||
        row.producerDigest !== plan.producerDigest ||
        row.qualificationId !== plan.qualificationId ||
        row.evidenceClass !== plan.evidenceClass
      )
        return no('tournament_holdout_source_or_window_mismatch');
      if (
        !exact(row.oracle, ['fold', 'call']) ||
        ![row.oracle.fold, row.oracle.call].every((u) => Number.isFinite(u) && u >= 0 && u <= 1)
      )
        return no('tournament_holdout_oracle_invalid');
      const model = buildOriginalTournamentRiverDecision(row.original);
      if (model.status !== 'built') return no('tournament_holdout_model:' + model.reason);
      if (
        model.modelVersion !== definition.model.version ||
        model.prices.objective !== definition.objective ||
        model.prices.utilityUnit !== definition.utilityUnit
      )
        return no('tournament_holdout_model_objective_mismatch');
      const proposal = proposeOriginalTournamentRiverCorrection(row.original, row.baselineDecision);
      if (proposal.status === 'unavailable')
        return no('tournament_holdout_policy:' + proposal.reason);
      let delta = 0;
      if (proposal.status === 'proposed') {
        if (
          proposal.objective !== identity.objective ||
          proposal.utilityUnit !== identity.utilityUnit ||
          proposal.conditionalProbability !==
            TOURNAMENT_RIVER_CORRECTION_KERNEL.conditionalProbability
        )
          return no('tournament_holdout_policy_definition_mismatch');
        const utility = (action: string) => (action === 'fold' ? row.oracle.fold : row.oracle.call);
        delta =
          proposal.conditionalProbability *
          (utility(proposal.to.action) - utility(proposal.from.action));
        changed++;
      }
      if (!Number.isFinite(delta) || Math.abs(delta) > plan.maximumAbsoluteDelta)
        return no('tournament_holdout_predeclared_bound_exceeded');
      deltas.push(delta);
      measurement.update('\n').update(
        evidenceDigest({
          handKey: row.handKey,
          playedAt: row.playedAt,
          sourceRelease: row.sourceRelease,
          producerDigest: row.producerDigest,
          qualificationId: row.qualificationId,
          evidenceClass: row.evidenceClass,
          decisionDigest: row.decisionDigest,
          acceptedHandDigest: row.acceptedHandDigest,
          originalInputDigest: evidenceDigest(row.original.snapshot),
          originalReadFrameDigest: evidenceDigest(row.original.readFrame),
          samplingContractDigest: model.samplingContractDigest,
          reference: model.prices,
          baseline: row.baselineDecision,
          oracle: row.oracle,
          proposal,
          delta,
        })
      );
    }
    const result = measurePairedHoldoutDeltas(deltas, changed, plan);
    if (result.status !== 'measured') return no(result.reason);
    return { ...identity, ...result, reasons: [], measurementDigest: measurement.digest('hex') };
  } catch {
    return no('tournament_holdout_unreadable');
  }
}
