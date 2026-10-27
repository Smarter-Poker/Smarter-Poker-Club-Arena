import {
  authenticateIncrementalPlan,
  incrementalQualificationRules,
  isIncrementalQualificationTarget,
  TOURNAMENT_RESERVED_HOLDOUT_SEEDS,
} from './IncrementalPressureQualification.js';
/** Shared physical, after-rake flag-ablation runner. Development evidence only
 * until a separately protected, locked experiment supplies its exact matrix.
 * This module has no production writer or policy activation capability. */
import { createHash } from 'node:crypto';
import {
  playPlo4PolicyHand,
  plo4DivergenceStreet,
  plo4LeagueSeating,
  type Plo4AblationBrain,
  type Plo4AblationFlags,
  type Plo4AblationPopulation,
  type Plo4HandReceipt,
  type Plo4LeagueProfile,
} from './Plo4PolicyLeague.js';
import {
  isPlo4HoldoutSeed,
  Plo4PowerAccumulator,
  type Plo4PowerSums,
} from './Plo4StrengthContract.js';
import { isOmahaVariantHoldoutSeed } from './OmahaVariantStrengthContract.js';
import { isRemainingVariantHoldoutSeed } from './RemainingVariantStrengthContract.js';
import { isJointHoldoutSeed } from './JointStrengthContract.js';
import { PLO6_V24_DEVELOPMENT_DESIGN } from './Plo6V24Qualification.js';
import { V53_PRESSURE_RESERVED_HOLDOUT_SEEDS } from './PressureQualificationContract.js';
import {
  INCREMENTAL_RESERVED_HOLDOUT_SEEDS,
  ADDITIONAL_RESERVED_HOLDOUT_SEEDS,
  PRESSURE_PACKAGE_FLAGS,
  PRESSURE_PACKAGE_POPULATION,
} from './IncrementalPressureDevelopment.js';

export interface FeatureAblationSpec {
  id: string;
  profile: Readonly<Plo4LeagueProfile>;
  brain: Plo4AblationBrain;
  candidate: Plo4AblationFlags;
  reference: Plo4AblationFlags;
  population?: Plo4AblationPopulation;
}
/** Independent profile domains; only the two arms of ONE paired deal share
 * this stream. Preregistered before held-outs to match stratified independent-
 * profile variance. Legacy leagues retain their existing sampler. */
export const FEATURE_ABLATION_DEAL_SAMPLER = 'sha256-profile-seed-index-v1';
export function featureAblationDealSeed(
  profileId: string,
  seed: number,
  pairIndex: number
): number {
  if (
    !profileId ||
    !Number.isSafeInteger(seed) ||
    seed < 1 ||
    seed > 0xffffffff ||
    !Number.isSafeInteger(pairIndex) ||
    pairIndex < 0 ||
    pairIndex > 0xffffffff
  )
    throw new Error('Invalid feature-ablation draw coordinate');
  return (
    createHash('sha256')
      .update('horse-feature-ablation-deal-v1\0', 'utf8')
      .update(JSON.stringify([profileId, seed, pairIndex]), 'utf8')
      .digest()
      .readUInt32BE(0) || 1
  );
}

export interface FeatureAblationPairRecord {
  index: number;
  dealSeed: number;
  heroSeat: number;
  button: number;
  relativePosition: number;
  candidateNetCents: number;
  referenceNetCents: number;
  differenceCents: number;
  street: string;
  candidateTrace: readonly string[];
  referenceTrace: readonly string[];
  candidateFees: { rake: number; bbj: number };
  referenceFees: { rake: number; bbj: number };
}
export interface FeatureAblationResult {
  schema: 'horse-feature-ablation-shard-v1';
  mode: 'development' | 'contract';
  experimentId: string;
  profileId: string;
  brainId: string;
  populationId: string;
  seed: number;
  startPair: number;
  requestedPairs: number;
  pairs: number;
  complete: boolean;
  candidate: Plo4AblationFlags;
  reference: Plo4AblationFlags;
  sums: Plo4PowerSums;
  strata: Record<string, Plo4PowerSums>;
  positionCounts: number[];
  pairDigest: string;
  candidateNetCents: number;
  referenceNetCents: number;
  changedPairs: number;
  candidateHeroDecisions: number;
  referenceHeroDecisions: number;
  candidateHeroActionContrastPairs: number;
  candidateEvaluationFires: { hero: Record<string, number>; opponents: Record<string, number> };
  referenceEvaluationFires: { hero: Record<string, number>; opponents: Record<string, number> };
  candidatePlanDispositions: Record<string, number>;
  referencePlanDispositions: Record<string, number>;
  protocolErrors: number;
  brainExceptions: number;
  refusalReason: string | null;
  decisions: number;
  illegalActions: number;
  conservationErrors: number;
  cardErrors: number;
  truncatedHands: number;
  settlementMismatches: number;
  deductionMismatches: number;
  pairedReplayMismatches: number;
  showdownsChecked: number;
  foldWinsChecked: number;
  rakeCents: number;
  bbjCents: number;
  durationMs: number;
  promotionEligible: false;
}
export function assertAblationArms(spec: FeatureAblationSpec): void {
  const keys = [...new Set([...Object.keys(spec.candidate), ...Object.keys(spec.reference)])];
  if (
    keys.length !== 1 ||
    ![
      'v24PloDefense',
      'v53Pressure',
      'comboDrawPressure',
      'v54RiverBluff',
      'riverPositionDefense',
      'riverBluffCheckRaise',
      'barrelContinuationOutlook',
    ].includes(keys[0]) ||
    Object.values(spec.candidate).some((v) => typeof v !== 'boolean') ||
    Object.values(spec.reference).some((v) => typeof v !== 'boolean') ||
    Object.keys(spec.candidate).length !== 1 ||
    Object.keys(spec.reference).length !== 1 ||
    spec.candidate[keys[0] as keyof Plo4AblationFlags] ===
      spec.reference[keys[0] as keyof Plo4AblationFlags]
  )
    throw new Error('A flag ablation changes exactly one explicit boolean flag');
  if (!spec.brain.id || !spec.id || !spec.profile.id || spec.profile.ablation)
    throw new Error('A flag ablation requires an identified brain and pristine physical profile');
  if (
    !spec.profile.publishedRake ||
    spec.profile.tournament ||
    spec.profile.anteBB ||
    spec.profile.straddle
  )
    throw new Error('A flag ablation requires the published ordinary cash pricing domain');
  const variant = spec.profile.variant ?? 'plo4';
  if (
    !['nlh', 'plo4', 'plo5', 'plo6'].includes(variant) ||
    (keys[0] === 'v24PloDefense' && variant !== 'plo6') ||
    ![2, 4, 6].includes(spec.profile.seats) ||
    ![40, 100, 200].includes(spec.profile.stackBB) ||
    spec.profile.tableSeats !== 6 ||
    !spec.profile.productionStyles
  )
    throw new Error('A flag ablation is outside the declared six-max cash development domain');
}
export function ablationPilotMoments(s: Plo4PowerSums) {
  const n = s.n,
    mean = n ? Number(s.s1) / n : 0;
  const m2 = n ? Number(s.s2) / n - mean ** 2 : 0;
  const m4 = n
    ? Number(s.s4) / n -
      (4 * mean * Number(s.s3)) / n +
      (6 * mean ** 2 * Number(s.s2)) / n -
      3 * mean ** 4
    : 0;
  return {
    pairs: n,
    standardDeviationBb: n > 1 ? Math.sqrt((Math.max(0, m2) * n) / (n - 1)) / 200 : null,
    kurtosis: m2 > 0 ? m4 / (m2 * m2) : null,
  };
}
/** Only this exact five-flag contrast is admitted in development. The
 * protected contract path still calls the unchanged single-flag validator. */
export function assertDevelopmentAblationArms(spec: FeatureAblationSpec): void {
  if (spec.id !== 'pressure_package-development-v1') return assertAblationArms(spec);
  const exact = (arm: Plo4AblationFlags, value: boolean) =>
    Object.keys(arm).length === PRESSURE_PACKAGE_FLAGS.length &&
    PRESSURE_PACKAGE_FLAGS.every((flag) => Object.hasOwn(arm, flag) && arm[flag] === value);
  if (
    !exact(spec.candidate, true) ||
    !exact(spec.reference, false) ||
    spec.population !== PRESSURE_PACKAGE_POPULATION ||
    !spec.profile.id.startsWith('pressure_package-')
  )
    throw new Error('Only the exact declared five-flag development package is admitted');
  assertAblationArms({
    ...spec,
    candidate: { comboDrawPressure: true },
    reference: { comboDrawPressure: false },
  });
}
export async function runFeatureAblationDevelopment(
  spec: FeatureAblationSpec,
  request: { seed: number; pairs: number; startPair?: number; reservedSeeds?: readonly number[] },
  shouldContinue = () => true,
  onPair?: (record: FeatureAblationPairRecord) => void | Promise<void>
): Promise<FeatureAblationResult> {
  assertDevelopmentAblationArms(spec);
  const { seed, pairs } = request,
    startPair = request.startPair ?? 0;
  if (
    !Number.isSafeInteger(seed) ||
    seed < 1 ||
    seed > 0xffffffff ||
    isPlo4HoldoutSeed(seed) ||
    isOmahaVariantHoldoutSeed(seed) ||
    isRemainingVariantHoldoutSeed(seed) ||
    isJointHoldoutSeed(seed) ||
    (PLO6_V24_DEVELOPMENT_DESIGN.reservedHeldoutSeeds as readonly number[]).includes(seed) ||
    (V53_PRESSURE_RESERVED_HOLDOUT_SEEDS as readonly number[]).includes(seed) ||
    (INCREMENTAL_RESERVED_HOLDOUT_SEEDS as readonly number[]).includes(seed) ||
    (ADDITIONAL_RESERVED_HOLDOUT_SEEDS as readonly number[]).includes(seed) ||
    (TOURNAMENT_RESERVED_HOLDOUT_SEEDS as readonly number[]).includes(seed) ||
    request.reservedSeeds?.includes(seed)
  )
    throw new Error('Development never deals a held-out or invalid seed');
  if (
    !Number.isSafeInteger(pairs) ||
    pairs < 1 ||
    pairs > 10368 ||
    !Number.isSafeInteger(startPair) ||
    startPair < 0 ||
    startPair + pairs > 0xffffffff
  )
    throw new Error('Invalid finite development pair range');
  return runFeatureAblationCore(
    spec,
    { seed, pairs, startPair },
    'development',
    shouldContinue,
    onPair
  );
}

/** A locked provider contrast never calls the development export. The exact
 * protected registry, physical profile, range and source are checked before
 * the provider authorization callback and before the first physical deal. */
export async function runFeatureAblationContract(
  spec: FeatureAblationSpec,
  request: { seed: number; pairs: number; startPair: number; planDigest: string; cellKey: string },
  authorizedGuard: () => void | Promise<void>,
  onPair?: (record: FeatureAblationPairRecord) => void | Promise<void>,
  shouldContinue = () => true
): Promise<FeatureAblationResult & { mode: 'contract' }> {
  const {
    qualificationPlan,
    qualificationPlanDigest,
    assertProtectedFeatureAblationSource,
    featureQualificationCanonical: canonical,
  } = await import('./FeatureAblationQualification.js');
  const { INCREMENTAL_FLAGS } = await import('./IncrementalPressureDevelopment.js');
  const keys = Object.keys(spec.candidate);
  const target =
    keys.length === 5
      ? 'pressure_package'
      : keys[0] === 'v24PloDefense'
        ? 'plo6_v24'
        : keys[0] === 'v53Pressure'
          ? 'v53_pressure'
          : Object.entries(INCREMENTAL_FLAGS).find(([, flag]) => flag === keys[0])?.[0];
  if (
    !target ||
    (!isIncrementalQualificationTarget(target) &&
      target !== 'plo6_v24' &&
      target !== 'v53_pressure')
  )
    throw Error('Incremental candidate has no protected locked heldout plan');
  if (target === 'pressure_package') {
    const rules = incrementalQualificationRules(target);
    if (
      canonical(spec.candidate) !== canonical(rules.flags.candidate) ||
      canonical(spec.reference) !== canonical(rules.flags.reference) ||
      spec.population !== rules.population
    )
      throw Error('Unregistered package');
    assertAblationArms({
      ...spec,
      candidate: { comboDrawPressure: true },
      reference: { comboDrawPressure: false },
    });
  } else assertAblationArms(spec);
  const plan = qualificationPlan(target);
  if (isIncrementalQualificationTarget(target)) {
    const { isActualFeatureAblationWorker } = await import('./FeatureAblationWorker.js');
    if (
      !isActualFeatureAblationWorker(spec.brain) ||
      spec.population !== incrementalQualificationRules(target).population
    )
      throw Error('Incremental original worker/population required');
  }
  const cell = plan.matrix.find((c) => c.key === request.cellKey);
  const profile = plan.profiles.find((p) => p.id === cell?.profileId);
  if (
    !cell ||
    !profile ||
    qualificationPlanDigest(plan) !== request.planDigest ||
    cell.seed !== request.seed ||
    cell.firstPair !== request.startPair ||
    cell.pairs !== request.pairs ||
    spec.id !== plan.version ||
    spec.brain.id !== 'current-worker-original-observer-controlled-crn-v1' ||
    (spec.population?.id ?? 'current_horse_production_styles') !== plan.population ||
    canonical(spec.candidate) !== canonical(plan.flags.candidate) ||
    canonical(spec.reference) !== canonical(plan.flags.reference)
  )
    throw new Error('Contract-only ablation identity/range refused');
  const { getFullRakeConfig } = await import('../config/RakeConfig.js');
  const rake = getFullRakeConfig(1, 2, profile.variant);
  const expected = {
    id: profile.id,
    variant: profile.variant,
    seats: profile.seats,
    stackBB: profile.stackBB,
    tableSeats: 6,
    publishedRake: true,
    productionStyles: true,
    moodClock: 'deal_seed_time_of_day',
    rakePercent: rake.rakePercent,
    rakeCapBB: rake.rakeCap / 2,
    anteBB: 0,
    straddle: false,
    tournament: false,
    opponentStyle: 'balanced',
  };
  if (canonical(spec.profile) !== canonical(expected))
    throw new Error('Contract physical profile changed');
  assertProtectedFeatureAblationSource(plan);
  await authenticateIncrementalPlan(plan, request.cellKey);
  if (typeof authorizedGuard !== 'function')
    throw new Error('Original provider authorization unavailable');
  await authorizedGuard();
  const result = await runFeatureAblationCore(spec, request, 'contract', shouldContinue, onPair);
  return result as FeatureAblationResult & { mode: 'contract' };
}

async function runFeatureAblationCore(
  spec: FeatureAblationSpec,
  request: { seed: number; pairs: number; startPair: number },
  mode: 'development' | 'contract',
  shouldContinue: () => boolean,
  onPair?: (record: FeatureAblationPairRecord) => void | Promise<void>
): Promise<FeatureAblationResult> {
  const { seed, pairs, startPair } = request;
  const started = performance.now(),
    sums = new Plo4PowerAccumulator();
  const strata = new Map<string, Plo4PowerAccumulator>(),
    digest = createHash('sha256');
  const result: FeatureAblationResult = {
    schema: 'horse-feature-ablation-shard-v1',
    mode,
    experimentId: spec.id,
    profileId: spec.profile.id,
    brainId: spec.brain.id,
    populationId: spec.population?.id ?? 'current_horse_production_styles',
    seed,
    startPair,
    requestedPairs: pairs,
    pairs: 0,
    complete: false,
    candidate: spec.candidate,
    reference: spec.reference,
    sums: sums.toJSON(),
    strata: {},
    positionCounts: Array(spec.profile.seats).fill(0),
    pairDigest: '',
    candidateNetCents: 0,
    referenceNetCents: 0,
    changedPairs: 0,
    candidateHeroDecisions: 0,
    referenceHeroDecisions: 0,
    candidateHeroActionContrastPairs: 0,
    candidateEvaluationFires: { hero: {}, opponents: {} },
    referenceEvaluationFires: { hero: {}, opponents: {} },
    candidatePlanDispositions: {},
    referencePlanDispositions: {},
    protocolErrors: 0,
    brainExceptions: 0,
    refusalReason: null,
    decisions: 0,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    truncatedHands: 0,
    settlementMismatches: 0,
    deductionMismatches: 0,
    pairedReplayMismatches: 0,
    showdownsChecked: 0,
    foldWinsChecked: 0,
    rakeCents: 0,
    bbjCents: 0,
    durationMs: 0,
    promotionEligible: false,
  };
  const absorb = (h: Plo4HandReceipt, arm: 'candidate' | 'reference') => {
    result.brainExceptions += h.ablationBrainExceptions ?? 0;
    if (arm === 'candidate') result.candidateHeroDecisions += h.ablationHeroDecisions ?? 0;
    else result.referenceHeroDecisions += h.ablationHeroDecisions ?? 0;
    const plan =
      arm === 'candidate' ? result.candidatePlanDispositions : result.referencePlanDispositions;
    for (const [k, v] of Object.entries(h.ablationPlanDispositions ?? {}))
      plan[k] = (plan[k] ?? 0) + v;
    if (h.ablationEvaluationFires)
      for (const seat of ['hero', 'opponents'] as const)
        for (const [feature, count] of Object.entries(h.ablationEvaluationFires[seat])) {
          const target =
            arm === 'candidate'
              ? result.candidateEvaluationFires[seat]
              : result.referenceEvaluationFires[seat];
          target[feature] = (target[feature] ?? 0) + count;
        }
    result.decisions += h.decisions;
    result.illegalActions += h.illegalActions;
    result.conservationErrors += h.conservationErrors;
    result.cardErrors += h.cardErrors;
    result.truncatedHands += h.truncated;
    result.rakeCents += Math.round(h.rake * 100);
    result.bbjCents += Math.round(h.bbj * 100);
    if (h.checks) {
      result.settlementMismatches += h.checks.settlementMismatches;
      result.deductionMismatches += h.checks.deductionMismatches;
      result.showdownsChecked += Number(h.checks.showdownChecked);
      result.foldWinsChecked += Number(h.checks.foldWinChecked);
    }
  };
  for (let k = 0; k < pairs && shouldContinue(); k++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const i = startPair + k,
      dealSeed = featureAblationDealSeed(spec.profile.id, seed, i);
    const { heroSeat, button, relativePosition } = plo4LeagueSeating(i, spec.profile.seats);
    const play = (heroOpts: Plo4AblationFlags) =>
      playPlo4PolicyHand(
        { ...spec.profile, ablation: { brain: spec.brain, population: spec.population, heroOpts } },
        dealSeed,
        button,
        heroSeat,
        'off',
        shouldContinue,
        true
      );
    let candidate: Plo4HandReceipt;
    try {
      candidate = await play(spec.candidate);
    } catch (error) {
      result.protocolErrors++;
      result.refusalReason = String(error).slice(0, 512);
      break;
    }
    absorb(candidate, 'candidate');
    if (!candidate.complete || !candidate.checks) break;
    let reference: Plo4HandReceipt;
    try {
      reference = await play(spec.reference);
    } catch (error) {
      result.protocolErrors++;
      result.refusalReason = String(error).slice(0, 512);
      break;
    }
    absorb(reference, 'reference');
    if (!reference.complete || !reference.checks) break;
    const a = Math.round(candidate.net[heroSeat - 1] * 100),
      b = Math.round(reference.net[heroSeat - 1] * 100);
    const difference = a - b,
      street = plo4DivergenceStreet(candidate.checks.trace, reference.checks.trace);
    result.pairedReplayMismatches += Number(street === 'none' && difference !== 0);
    const key = `${relativePosition}|${street}`,
      acc = strata.get(key) ?? new Plo4PowerAccumulator();
    acc.add(difference);
    strata.set(key, acc);
    sums.add(difference);
    result.positionCounts[relativePosition]++;
    result.candidateNetCents += a;
    result.referenceNetCents += b;
    result.changedPairs += Number(street !== 'none');
    const heroAction = new RegExp(`^${heroSeat}:(fold|check|call|bet|raise|all_in):`);
    result.candidateHeroActionContrastPairs += Number(
      JSON.stringify(candidate.checks.trace.filter((a) => heroAction.test(a))) !==
        JSON.stringify(reference.checks.trace.filter((a) => heroAction.test(a)))
    );
    await onPair?.({
      index: i,
      dealSeed,
      heroSeat,
      button,
      relativePosition,
      candidateNetCents: a,
      referenceNetCents: b,
      differenceCents: difference,
      street,
      candidateTrace: candidate.checks.trace,
      referenceTrace: reference.checks.trace,
      candidateFees: { rake: candidate.rake, bbj: candidate.bbj },
      referenceFees: { rake: reference.rake, bbj: reference.bbj },
    });
    digest.update(
      JSON.stringify([
        i,
        dealSeed,
        heroSeat,
        button,
        a,
        b,
        candidate.checks.trace,
        reference.checks.trace,
        candidate.rake,
        reference.rake,
        candidate.bbj,
        reference.bbj,
      ]) + '\n'
    );
    result.pairs++;
  }
  result.sums = sums.toJSON();
  result.strata = Object.fromEntries([...strata].sort().map(([k, v]) => [k, v.toJSON()]));
  result.pairDigest = digest.digest('hex');
  result.complete = result.pairs === pairs && result.protocolErrors === 0;
  result.durationMs = Math.round(performance.now() - started);
  return result;
}
