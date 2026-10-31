import { HORSE_REFERENCE_DECISION_SOURCE_REASONS } from '../engine/HorseReferenceDecisionSources.js';
import { featureLiveDomainRefusals as validateLiveDeclaration } from '../engine/HorseFeatureLiveDomain.js';
import {
  incrementalDevelopmentProfiles,
  isSeparateRiverTarget,
} from './IncrementalPressureDevelopment.js';
import { publishedCashPricing } from '../config/leagueCashPricing.js';
export function featureLiveDomainRefusals(plan: FeatureAblationQualificationPlan): string[] {
  const reasons = validateLiveDeclaration(plan);
  if (reasons.length) return reasons;
  const declaration = plan.liveAdmission!,
    d = declaration.domain;
  const actual = incrementalDevelopmentProfiles(
    plan.target as import('./IncrementalPressureDevelopment.js').IncrementalTarget,
    d.variant
  ).find((p) => p.id === declaration.profileId);
  if (
    !actual ||
    actual.stackBB !== d.startingStackBB ||
    actual.seats !== d.dealtSeats[0] ||
    actual.anteBB !== 0 ||
    actual.tournament ||
    actual.straddle ||
    !actual.publishedRake ||
    (actual.asset && actual.asset !== 'chips')
  )
    return ['live_domain_physical_profile'];
  const pricing = publishedCashPricing(actual);
  if (
    featureQualificationCanonical(pricing.rakeConfig) !==
      featureQualificationCanonical(d.rakeConfig) ||
    featureQualificationCanonical(pricing.bbjConfig) !== featureQualificationCanonical(d.bbjConfig)
  )
    return ['live_domain_physical_pricing'];
  return [];
}
/** Generic locked flag-contrast contract. No plan, sample size or positive
 * verdict is supplied by this module. Actual plans must be frozen after the
 * separate development pilot and protected-merged before any held-out deal. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  Plo4PowerAccumulator,
  plo4CellStatistic,
  PLO4_STRENGTH_CONTRACT,
  type Plo4PowerSums,
} from './Plo4StrengthContract.js';
import { positionForOffset } from '../engine/plo4/Plo4PolicyPack.js';
import type { FeatureAblationResult } from './FeatureAblationLeague.js';
import { PLO6_V24_DEVELOPMENT_DESIGN } from './Plo6V24Qualification.js';
import { V53_PRESSURE_RESERVED_HOLDOUT_SEEDS } from './PressureQualificationContract.js';
import {
  incrementalComponentCoverage,
  assertIncrementalWorkerFlags,
  incrementalQualificationRules,
  isIncrementalQualificationTarget,
} from './IncrementalPressureQualification.js';
import { V53_PRESSURE_POPULATION_ID } from './V53PressurePopulation.js';

export type LegacyFeatureAblationTarget = 'plo6_v24' | 'v53_pressure';
export type FeatureAblationTarget =
  | LegacyFeatureAblationTarget
  | import('./IncrementalPressureDevelopment.js').IncrementalTarget;
export type FeatureVariant = 'nlh' | 'plo4' | 'plo5' | 'plo6';
export interface FeatureQualificationProfile {
  id: string;
  variant: FeatureVariant;
  seats: 2 | 4 | 6;
  stackBB: 40 | 100 | 200;
  weight: number;
}
export interface FeatureQualificationCell {
  key: string;
  profileId: string;
  variant: FeatureVariant;
  seed: number;
  shard: number;
  firstPair: number;
  pairs: number;
}
export interface FeatureAblationQualificationPlan {
  liveAdmission?: import('../engine/HorseFeatureLiveDomain.js').HorseFeatureLiveDeclaration;
  schema: 'horse-feature-ablation-plan-v1' | 'horse-incremental-ablation-plan-v2';
  version: string;
  state: 'heldout_locked';
  target: FeatureAblationTarget;
  dealSampler: 'sha256-profile-seed-index-v1';
  baselineReferenceRevision: string;
  runtimeSourceFiles: Record<string, string>;
  runtimeSourceDigest: string;
  policyDigests: Record<string, string>;
  policyDigestsDigest: string;
  dependencyDigest: string;
  storeInputsDigest: string;
  admissionDigest: string;
  historyDigest: string;
  maxAttempts: number;
  pooledPublicProfiles: { kind: 'empty_for_local_simulation'; bootstrap: null; profiles: 0 };
  flags: {
    candidate: Record<string, boolean>;
    reference: Record<string, boolean>;
  };
  population: string;
  clock: {
    policyDateMs: number;
    publicHistoryAvailableAtMs: number;
    warmSeed: number;
  };
  profiles: FeatureQualificationProfile[];
  heldoutSeeds: number[];
  matrix: FeatureQualificationCell[];
  interval: typeof PLO4_STRENGTH_CONTRACT.interval;
  thresholds: {
    primaryLowerBoundAboveBb100: 0;
    eachSeedPointEstimateAboveBb100: 0;
    everyCriticalCellLowerBoundAtLeastBb100: -10;
  };
  criticalCells: ('profile' | 'relative_position' | 'depth')[];
  coverage: {
    opportunityDenominator: 'not_measured';
    byProfile: Record<
      string,
      {
        candidateHeroDecisionsMinimum: number;
        referenceHeroDecisionsMinimum: number;
        acceptedHeroContrastsMinimum: number;
        evaluationCounterMinimums: Record<string, number>;
      }
    >;
  };
}
export interface FeatureAblationCellEnvelope {
  schema: 'horse-feature-ablation-cell-v1';
  mode: 'contract';
  target: FeatureAblationTarget;
  cellKey: string;
  sourceSha: string;
  planDigest: string;
  policyDigestsDigest: string;
  dependencyDigest: string;
  storeInputsDigest: string;
  admissionDigest: string;
  historyDigest: string;
  operation: Record<string, unknown>;
  result: Omit<FeatureAblationResult, 'schema'> & {
    schema: 'horse-feature-ablation-shard-v1';
    mode: 'contract';
    candidateHeroDecisions: number;
    referenceHeroDecisions: number;
    candidateHeroActionContrastPairs: number;
  };
  rawPairsSha256: string;
  rawPairCount: number;
  execution: {
    workerReceiptSha256: string;
    workerReceiptCount: number;
    sampledWorkerReceipts: unknown[];
  };
}
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export function featureQualificationCanonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(featureQualificationCanonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            featureQualificationCanonical((v as Record<string, unknown>)[k])
        )
        .join(',') +
      '}'
    );
  const encoded = JSON.stringify(v);
  if (encoded === undefined || (typeof v === 'number' && !Number.isFinite(v)))
    throw Error('Non-JSON scientific value');
  return encoded;
}
export const qualificationPlanDigest = (p: FeatureAblationQualificationPlan) =>
  sha(featureQualificationCanonical(p));
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const int = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const equal = (a: unknown, b: unknown) =>
  a === undefined || b === undefined
    ? a === b
    : featureQualificationCanonical(a) === featureQualificationCanonical(b);
const variants = (target: FeatureAblationTarget): FeatureVariant[] =>
  target === 'plo6_v24'
    ? ['plo6']
    : target === 'small_pot_near_nut_value_raise'
      ? ['plo4', 'plo5', 'plo6']
      : ['nlh', 'plo4', 'plo5', 'plo6'];
const SHAPES = ['2:100', '4:100', '6:40', '6:100', '6:200'];
const BINDINGS = [
  'policyDigestsDigest',
  'dependencyDigest',
  'storeInputsDigest',
  'admissionDigest',
  'historyDigest',
] as const;
const ERRORS = [
  'protocolErrors',
  'brainExceptions',
  'illegalActions',
  'conservationErrors',
  'cardErrors',
  'truncatedHands',
  'settlementMismatches',
  'deductionMismatches',
  'pairedReplayMismatches',
] as const;
export const FEATURE_ABLATION_REQUIRED_RUNTIME_FILES = [
  'src/engine/HorseLogic.ts',
  'src/engine/HandController.ts',
  'src/engine/horseDecision/workerRuntime.ts',
  'src/engine/horseDecision/client.ts',
  'src/benchmark/Plo4PolicyLeague.ts',
  'src/benchmark/FeatureAblationLeague.ts',
  'src/benchmark/FeatureAblationWorker.ts',
  'src/benchmark/FeatureAblationAcceptance.ts',
  'src/benchmark/FeatureAblationHistory.ts',
  'src/benchmark/FeatureAblationStores.ts',
  'src/benchmark/V53PressurePopulation.ts',
  'src/benchmark/FeatureAblationQualification.ts',
  'src/scripts/featureAblationQualify.ts',
];
function positive(n: unknown) {
  return int(n) && n > 0;
}
export function validateLockedFeatureAblationPlan(p: FeatureAblationQualificationPlan): string[] {
  const incremental = isIncrementalQualificationTarget(p?.target)
    ? incrementalQualificationRules(p.target)
    : null;
  const reasons: string[] = [];
  const bad = (s: string) => reasons.push(s);
  if (
    !p ||
    p.schema !==
      (incremental ? 'horse-incremental-ablation-plan-v2' : 'horse-feature-ablation-plan-v1') ||
    p.state !== 'heldout_locked' ||
    (!incremental && !['plo6_v24', 'v53_pressure'].includes(p.target)) ||
    !p.version
  )
    return ['heldout_plan_not_locked'];
  if (
    !/^[0-9a-f]{40}$/.test(p.baselineReferenceRevision) ||
    !BINDINGS.every((k) => digest(p[k])) ||
    !digest(p.runtimeSourceDigest)
  )
    bad('baseline_identity');
  if (
    !p.runtimeSourceFiles ||
    !FEATURE_ABLATION_REQUIRED_RUNTIME_FILES.every((k) => digest(p.runtimeSourceFiles[k])) ||
    Object.keys(p.runtimeSourceFiles).some(
      (k) =>
        (!k.startsWith('src/') && !Object.hasOwn(HORSE_REFERENCE_DECISION_SOURCE_REASONS, k)) ||
        k.includes('..') ||
        k.endsWith('FeatureAblationQualificationPlans.json')
    ) ||
    Object.values(p.runtimeSourceFiles).some((v) => !digest(v)) ||
    sha(featureQualificationCanonical(p.runtimeSourceFiles)) !== p.runtimeSourceDigest
  )
    bad('runtime_source_closure');
  if (
    !p.policyDigests ||
    !Object.keys(p.policyDigests).length ||
    Object.values(p.policyDigests).some((v) => !digest(v)) ||
    sha(featureQualificationCanonical(p.policyDigests)) !== p.policyDigestsDigest
  )
    bad('policy_digest_map');
  if (!positive(p.maxAttempts) || p.maxAttempts > 10) bad('attempt_bound');
  if (p.dealSampler !== 'sha256-profile-seed-index-v1') bad('independent_profile_sampler');
  if (
    !equal(p.pooledPublicProfiles, {
      kind: 'empty_for_local_simulation',
      bootstrap: null,
      profiles: 0,
    })
  )
    bad('controlled_public_pool_input');
  const flag = p.target === 'plo6_v24' ? 'v24PloDefense' : 'v53Pressure';
  if (
    !equal(
      p.flags,
      incremental?.flags ?? {
        candidate: { [flag]: true },
        reference: { [flag]: false },
      }
    )
  )
    bad('one_flag_contrast');
  if (
    p.population !==
    (incremental?.population.id ??
      (p.target === 'v53_pressure'
        ? V53_PRESSURE_POPULATION_ID
        : 'current_horse_production_styles'))
  )
    bad('population');
  if (
    !equal(p.clock, {
      policyDateMs: Date.UTC(2026, 9, 26),
      publicHistoryAvailableAtMs: Date.UTC(2026, 9, 25, 23),
      warmSeed: incremental?.warmSeed ?? 24307777,
    })
  )
    bad('clock');
  if (
    !equal(p.interval, PLO4_STRENGTH_CONTRACT.interval) ||
    !equal(p.thresholds, {
      primaryLowerBoundAboveBb100: 0,
      eachSeedPointEstimateAboveBb100: 0,
      everyCriticalCellLowerBoundAtLeastBb100: -10,
    })
  )
    bad('statistical_gate_changed');
  if (
    !Array.isArray(p.criticalCells) ||
    !equal([...p.criticalCells].sort(), ['depth', 'profile', 'relative_position'])
  )
    bad('mandatory_critical_cells');
  const seeds =
    incremental?.seeds ??
    (p.target === 'plo6_v24'
      ? PLO6_V24_DEVELOPMENT_DESIGN.reservedHeldoutSeeds
      : V53_PRESSURE_RESERVED_HOLDOUT_SEEDS);
  if (!equal(p.heldoutSeeds, seeds)) bad('unregistered_holdout_seeds');
  if (
    !Array.isArray(p.profiles) ||
    new Set(p.profiles.map((x) => x?.id)).size !== p.profiles.length
  )
    return [...reasons, 'profile_shape'];
  for (const v of variants(p.target)) {
    const ps = p.profiles.filter((x) => x.variant === v);
    if (
      !equal(
        ps.map((x) => `${x.seats}:${x.stackBB}`).sort(),
        [...(incremental?.shapes ?? SHAPES)].sort()
      ) ||
      !ps.every((x) => x.id && Number.isFinite(x.weight) && x.weight > 0) ||
      !ps.every((x) => x.weight === ps[0]?.weight)
    )
      bad('physical_profiles:' + v);
  }
  if (p.profiles.some((x) => !variants(p.target).includes(x.variant))) bad('unexpected_variant');
  if (
    !Array.isArray(p.matrix) ||
    !p.matrix.length ||
    p.matrix.length > 256 ||
    new Set(p.matrix.map((c) => c?.key)).size !== p.matrix.length
  )
    return [...reasons, 'matrix_bound'];
  for (const c of p.matrix)
    if (
      !c ||
      !/^[a-z0-9_-]{1,100}$/.test(c.key) ||
      !p.profiles.some((x) => x.id === c.profileId && x.variant === c.variant) ||
      !p.heldoutSeeds.includes(c.seed) ||
      !int(c.firstPair) ||
      !positive(c.pairs) ||
      !int(c.shard) ||
      c.firstPair + c.pairs > 0xffffffff ||
      c.firstPair % 576 !== 0 ||
      c.pairs % 576 !== 0
    )
      bad('matrix_cell');
  for (const profile of p.profiles)
    for (const seed of p.heldoutSeeds) {
      const cells = p.matrix
        .filter((c) => c.profileId === profile.id && c.seed === seed)
        .sort((a, b) => a.firstPair - b.firstPair);
      let end = 0;
      if (!cells.length) bad('missing_profile_seed');
      cells.forEach((c, i) => {
        if (c.shard !== i || c.firstPair !== end) bad('matrix_overlap_or_gap');
        end = c.firstPair + c.pairs;
      });
      if (end % 576 !== 0) bad('incomplete_rotation_block');
    }
  if (
    p.coverage?.opportunityDenominator !== 'not_measured' ||
    !p.coverage.byProfile ||
    !equal(Object.keys(p.coverage.byProfile).sort(), p.profiles.map((x) => x.id).sort())
  )
    bad('coverage_registration');
  else
    for (const profile of p.profiles) {
      const c = p.coverage.byProfile[profile.id];
      if (
        !c ||
        ![
          c.candidateHeroDecisionsMinimum,
          c.referenceHeroDecisionsMinimum,
          c.acceptedHeroContrastsMinimum,
        ].every(positive) ||
        !c.evaluationCounterMinimums ||
        Object.values(c.evaluationCounterMinimums).some((x) => !positive(x)) ||
        (p.target === 'v53_pressure' &&
          (!Object.keys(c.evaluationCounterMinimums).length ||
            Object.keys(c.evaluationCounterMinimums).some((k) => !k.startsWith('v53_pressure_'))))
      )
        bad('coverage_minima:' + profile.id);
    }
  if (incremental) reasons.push(...incremental.validate(p));
  if (p.liveAdmission !== undefined) {
    reasons.push(...featureLiveDomainRefusals(p));
    if (
      ![
        'src/engine/HorseFeatureAuthority.ts',
        'src/engine/HorseFeatureLiveDomain.ts',
        'src/config/leagueCashPricing.ts',
      ].every((k) => digest(p.runtimeSourceFiles?.[k]))
    )
      bad('live_admission_source_closure');
  }
  return [...new Set(reasons)];
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
export function qualificationPlan(
  target: FeatureAblationTarget
): Readonly<FeatureAblationQualificationPlan> {
  if (!isIncrementalQualificationTarget(target) && !['plo6_v24', 'v53_pressure'].includes(target))
    throw Error('Unknown feature qualification target');
  const file = new URL(
    isSeparateRiverTarget(target)
      ? './SeparateRiverQualificationPlans.json'
      : isIncrementalQualificationTarget(target)
        ? './IncrementalPressureQualificationPlans.json'
        : './FeatureAblationQualificationPlans.json',
    import.meta.url
  );
  let registry: Record<string, FeatureAblationQualificationPlan>;
  try {
    registry = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw Error('No protected post-pilot locked feature-ablation plans');
  }
  const plan = registry[target],
    reasons = validateLockedFeatureAblationPlan(plan);
  if (reasons.length) throw Error('Feature-ablation plan refused: ' + reasons.join(','));
  return freeze(plan);
}
/** Independently used by the maintained contract wrapper before its private core. */
export function assertProtectedFeatureAblationSource(
  plan: FeatureAblationQualificationPlan,
  sourceSha?: string
) {
  const serverRoot = fileURLToPath(new URL('../../', import.meta.url)),
    env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...a: string[]) =>
    execFileSync('git', a, { cwd: serverRoot, env, encoding: 'utf8' }).trim();
  if (
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  )
    throw Error('Protected manual provider required');
  const head = git('rev-parse', 'HEAD');
  if ((sourceSha && sourceSha !== head) || git('status', '--porcelain', '--untracked-files=no'))
    throw Error('Evaluated source changed');
  git('merge-base', '--is-ancestor', head, 'origin/main');
  git('merge-base', '--is-ancestor', plan.baselineReferenceRevision, head);
  const introduction = git(
    'log',
    '--diff-filter=A',
    '--format=%H',
    '-1',
    '--',
    isSeparateRiverTarget(plan.target)
      ? 'src/benchmark/SeparateRiverQualificationPlans.json'
      : 'src/benchmark/FeatureAblationQualificationPlans.json'
  );
  if (!/^[0-9a-f]{40}$/.test(introduction)) throw Error('Locked contract introduction unproven');
  git('merge-base', '--is-ancestor', introduction, 'origin/main');
  for (const [file, d] of Object.entries(plan.runtimeSourceFiles))
    if (sha(readFileSync(resolve(serverRoot, file))) !== d)
      throw Error('Runtime source identity changed: ' + file);
  if (sha(readFileSync(resolve(serverRoot, 'package-lock.json'))) !== plan.dependencyDigest)
    throw Error('Dependency identity changed');
  return {
    sourceSha: head,
    protectedContractIntroduction: introduction,
    runtimeSourceDigest: plan.runtimeSourceDigest,
  };
}
export function validateFeatureAblationCell(
  plan: FeatureAblationQualificationPlan,
  cell: FeatureQualificationCell,
  e: FeatureAblationCellEnvelope
): string[] {
  const reasons = validateLockedFeatureAblationPlan(plan);
  const bad = (s: string) => reasons.push(s);
  const r = e?.result as FeatureAblationCellEnvelope['result'] & {
    schema: string;
    mode: string;
  };
  if (
    !e ||
    e.schema !== 'horse-feature-ablation-cell-v1' ||
    e.mode !== 'contract' ||
    e.target !== plan.target ||
    e.planDigest !== qualificationPlanDigest(plan) ||
    e.cellKey !== cell.key ||
    !BINDINGS.every((k) => e[k] === plan[k]) ||
    !plan.matrix.some((c) => equal(c, cell))
  )
    return [...reasons, 'cell_binding'];
  if (
    !r ||
    r.schema !== 'horse-feature-ablation-shard-v1' ||
    r.mode !== 'contract' ||
    r.complete !== true ||
    r.experimentId !== plan.version ||
    r.brainId !== 'current-worker-original-observer-controlled-crn-v1' ||
    r.promotionEligible !== false ||
    r.profileId !== cell.profileId ||
    r.seed !== cell.seed ||
    r.startPair !== cell.firstPair ||
    r.requestedPairs !== cell.pairs ||
    r.pairs !== cell.pairs ||
    r.sums?.n !== cell.pairs ||
    !equal(r.candidate, plan.flags.candidate) ||
    !equal(r.reference, plan.flags.reference) ||
    r.populationId !== plan.population ||
    r.refusalReason !== null
  )
    bad('scientific_cell_shape');
  if (!r) return reasons;
  for (const k of ERRORS) if (r[k] !== 0) bad('integrity:' + k);
  if (
    ![
      r.candidateHeroDecisions,
      r.referenceHeroDecisions,
      r.candidateHeroActionContrastPairs,
      r.changedPairs,
      r.decisions,
    ].every(int) ||
    r.candidateHeroActionContrastPairs > r.changedPairs ||
    r.candidateHeroActionContrastPairs > r.pairs
  )
    bad('observed_coverage_shape');
  for (const arm of ['candidate', 'reference'] as const) {
    const resolutions = r[`${arm}PlanDispositions`];
    if (
      !resolutions ||
      Object.entries(resolutions).some(
        ([k, v]) =>
          !['applied_volatile', 'already_applied_volatile', 'retired', 'already_retired'].includes(
            k
          ) || !int(v)
      )
    )
      bad('plan_terminal_disposition:' + arm);
    const fires = r[`${arm}EvaluationFires`];
    if (
      !fires ||
      !fires.hero ||
      !fires.opponents ||
      [...Object.values(fires.hero), ...Object.values(fires.opponents)].some((v) => !int(v))
    )
      bad('evaluation_counter_shape:' + arm);
  }
  const expectedReceipts =
    plan.target !== 'plo6_v24' ? r.candidateHeroDecisions + r.referenceHeroDecisions : r.decisions;
  if (
    !e.execution ||
    Object.keys(e.execution).some(
      (k) => !['workerReceiptSha256', 'workerReceiptCount', 'sampledWorkerReceipts'].includes(k)
    ) ||
    !positive(expectedReceipts) ||
    e.execution.workerReceiptCount !== expectedReceipts ||
    !digest(e.execution.workerReceiptSha256) ||
    !Array.isArray(e.execution.sampledWorkerReceipts) ||
    e.execution.sampledWorkerReceipts.length < 1 ||
    e.execution.sampledWorkerReceipts.length > 8 ||
    e.execution.sampledWorkerReceipts.length > expectedReceipts
  )
    bad('actual_validated_fast_receipts_missing');
  if (isIncrementalQualificationTarget(plan.target)) {
    try {
      for (const receipt of e.execution?.sampledWorkerReceipts ?? []) {
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          !('inputFlags' in receipt) ||
          !receipt.inputFlags ||
          typeof receipt.inputFlags !== 'object'
        )
          throw Error('missing flags');
        assertIncrementalWorkerFlags(plan.target, receipt.inputFlags as Record<string, unknown>);
      }
    } catch {
      bad('incremental_actual_worker_flags');
    }
  }
  if (e.rawPairCount !== cell.pairs || !digest(e.rawPairsSha256) || !digest(r.pairDigest))
    bad('raw_pair_binding');
  const profile = plan.profiles.find((p) => p.id === cell.profileId)!;
  if (
    r.positionCounts?.length !== profile.seats ||
    r.positionCounts.some((n) => !int(n)) ||
    r.positionCounts.reduce((a, b) => a + b, 0) !== cell.pairs ||
    new Set(r.positionCounts).size !== 1
  )
    bad('position_counts');
  try {
    const total = new Plo4PowerAccumulator();
    for (const [key, s] of Object.entries(r.strata)) {
      if (
        !new RegExp(`^[0-${profile.seats - 1}]\\|(none|preflop|flop|turn|river)$`).test(key) ||
        !int(s.n)
      )
        bad('stratum_shape');
      if (key.endsWith('|none') && [s.s1, s.s2, s.s3, s.s4].some((v) => v !== '0'))
        bad('paired_replay_mismatch');
      total.merge(s);
    }
    if (!equal(total.toJSON(), r.sums)) bad('strata_do_not_sum');
  } catch {
    bad('invalid_exact_moments');
  }
  return [...new Set(reasons)];
}

/** Original stratified statistic, independently within EACH variant. No NLH
 * contribution can offset a PLO4/5/6 loss. All critical cells are mandatory. */
export function summarizeFeatureAblationQualification(
  plan: FeatureAblationQualificationPlan,
  selectedResults: FeatureAblationCellEnvelope[]
) {
  const reasons = validateLockedFeatureAblationPlan(plan),
    seen = new Set<string>();
  for (const e of selectedResults) {
    const cell = plan.matrix.find((c) => c.key === e.cellKey);
    if (!cell || seen.has(e.cellKey)) reasons.push('foreign_or_duplicate_cell:' + e.cellKey);
    else {
      seen.add(e.cellKey);
      reasons.push(...validateFeatureAblationCell(plan, cell, e).map((x) => e.cellKey + ':' + x));
    }
  }
  for (const c of plan.matrix) if (!seen.has(c.key)) reasons.push('missing_cell:' + c.key);
  const byVariant: Record<string, unknown> = {};
  if (reasons.length)
    return {
      qualified: false,
      activationAllowed: false,
      reasons: [...new Set(reasons)],
      byVariant,
      opportunityDenominator: 'not_measured',
    };
  for (const variant of variants(plan.target)) {
    const profiles = plan.profiles.filter((p) => p.variant === variant),
      results = selectedResults.filter((e) => profiles.some((p) => p.id === e.result.profileId));
    const local: string[] = [];
    const statistic = (
      label: string,
      members: FeatureQualificationProfile[],
      seed: number | null = null,
      position: ReturnType<typeof positionForOffset> | null = null
    ) =>
      plo4CellStatistic(
        label,
        members.map((p) => {
          const a = new Plo4PowerAccumulator();
          for (const e of results) {
            if (e.result.profileId !== p.id || (seed !== null && e.result.seed !== seed)) continue;
            for (const [key, s] of Object.entries(e.result.strata))
              if (
                position === null ||
                positionForOffset(Number(key.split('|')[0]), p.seats) === position
              )
                a.merge(s);
          }
          return {
            profileId: p.id,
            weight: 1 / members.length,
            n: a.n,
            s1: a.s1,
            s2: a.s2,
            s3: a.s3,
          };
        })
      );
    const primary = statistic(variant + ':primary', profiles);
    if (!primary.intervalTrusted || !(primary.confidence99BbPer100[0] > 0))
      local.push('primary_not_trusted_positive');
    const seeds = plan.heldoutSeeds.map((seed) =>
      statistic(`${variant}:seed:${seed}`, profiles, seed)
    );
    for (const s of seeds)
      if (!Number.isFinite(s.meanBbPer100) || !(s.meanBbPer100 > 0))
        local.push(s.cell + ':point_not_positive');
    const critical = [
      ...profiles.map((p) => statistic(`${variant}:profile:${p.id}`, [p])),
      ...[
        ...new Set(
          profiles.flatMap((p) =>
            Array.from({ length: p.seats }, (_, offset) => positionForOffset(offset, p.seats))
          )
        ),
      ].map((position) =>
        statistic(
          `${variant}:relative_position:${position}`,
          profiles.filter((p) =>
            Array.from({ length: p.seats }, (_, offset) =>
              positionForOffset(offset, p.seats)
            ).includes(position)
          ),
          null,
          position
        )
      ),
      ...[...new Set(profiles.map((p) => p.stackBB))].map((depth) =>
        statistic(
          `${variant}:depth:${depth}`,
          profiles.filter((p) => p.stackBB === depth)
        )
      ),
    ];
    for (const s of critical)
      if (!s.intervalTrusted || s.confidence99BbPer100[0] < -10)
        local.push(s.cell + ':critical_nonregression_unproven');
    const coverage = profiles.map((p) => {
      const rows = results.filter((e) => e.result.profileId === p.id),
        minimum = plan.coverage.byProfile[p.id];
      const measured = {
        profile: p.id,
        candidateHeroDecisions: rows.reduce((n, e) => n + e.result.candidateHeroDecisions, 0),
        referenceHeroDecisions: rows.reduce((n, e) => n + e.result.referenceHeroDecisions, 0),
        acceptedHeroActionContrastPairs: rows.reduce(
          (n, e) => n + e.result.candidateHeroActionContrastPairs,
          0
        ),
        candidateHeroEvaluationCounters: Object.fromEntries(
          Object.keys(minimum.evaluationCounterMinimums).map((k) => [
            k,
            rows.reduce((n, e) => n + (e.result.candidateEvaluationFires.hero[k] ?? 0), 0),
          ])
        ),
      };
      if (
        measured.candidateHeroDecisions < minimum.candidateHeroDecisionsMinimum ||
        measured.referenceHeroDecisions < minimum.referenceHeroDecisionsMinimum ||
        measured.acceptedHeroActionContrastPairs < minimum.acceptedHeroContrastsMinimum ||
        Object.entries(minimum.evaluationCounterMinimums).some(
          ([k, n]) => measured.candidateHeroEvaluationCounters[k] < n
        )
      )
        local.push(p.id + ':insufficient_declared_counter_or_accepted_hero_coverage');
      return measured;
    });
    byVariant[variant] = {
      qualified: local.length === 0,
      reasons: local,
      primary,
      seeds,
      criticalCells: critical,
      coverage,
      opportunityDenominator: 'not_measured',
    };
    reasons.push(...local.map((r) => variant + ':' + r));
  }
  return {
    schema: 'horse-feature-ablation-qualification-v1',
    target: plan.target,
    planDigest: qualificationPlanDigest(plan),
    qualified: reasons.length === 0,
    activationAllowed: false,
    reasons: [...new Set(reasons)],
    byVariant,
    opportunityDenominator: 'not_measured',
    scope:
      plan.target !== 'plo6_v24'
        ? 'Registered after-rake contrast against the versioned adversarial stress workload; not calibrated human or market profitability'
        : 'Registered PLO6 V24 after-rake contrast against current horse production styles; not absolute profitability',
    ...(isIncrementalQualificationTarget(plan.target)
      ? {
          componentApplicability: plan.profiles.map((p) => ({
            profile: p.id,
            components: incrementalComponentCoverage(
              plan.target as import('./IncrementalPressureDevelopment.js').IncrementalTarget,
              p.seats
            ),
          })),
          componentScope:
            'Package qualification is only the exact combined contrast; no individual component qualification is inferred from pooled effects',
        }
      : {}),
    intervalScope:
      'Original per-cell 99 percent intervals; every registered critical cell must clear its original trust/nonregression gate',
  };
}
