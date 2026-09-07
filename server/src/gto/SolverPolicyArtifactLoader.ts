/**
 * Atomic, in-memory loader for versioned solver-policy artifacts.
 *
 * File and database I/O happen during boot or background refresh. The action
 * clock only performs synchronous Map reads.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  SOLVER_POLICY_CONTRACT_VERSION,
  SOLVER_POLICY_SCHEMA_SHA256,
  SOLVER_POLICY_VERSION,
  deepFreezeSolverPolicy,
  solverPolicyKeyMissingDimensions,
  stableSolverPolicyJson,
  validateSolverPolicyAnswer,
  validateSolverPolicyArtifactBundle,
  type SolverPolicyAction,
  type SolverPolicyAnswer,
  type SolverPolicyArtifactBundle,
  type SolverPolicyDecisionKey,
} from './SolverPolicyContract.js';

export interface ChartPolicyRow {
  chart_id?: string | null;
  game_type: string;
  stack_depth: number;
  hero_position: string;
  villain_action: string;
  hand_matrix: Record<string, Record<string, number | null>>;
  created_at?: string | null;
}

export interface ChartPolicyAdvice {
  action: string;
  freq: number;
  chart: string;
  policy: SolverPolicyAnswer;
}

interface LoadState {
  configured: boolean;
  count: number;
  loadedAt: string | null;
  lastError: string | null;
  sourceArtifact: string | null;
}

let externalByScenario = new Map<string, SolverPolicyAnswer>();
let externalByKey = new Map<string, SolverPolicyAnswer>();
let chartByLookup = new Map<string, SolverPolicyAnswer>();
let externalState: LoadState = {
  configured: false,
  count: 0,
  loadedAt: null,
  lastError: null,
  sourceArtifact: null,
};
let chartState: LoadState = {
  configured: true,
  count: 0,
  loadedAt: null,
  lastError: null,
  sourceArtifact: 'memory_charts_gold',
};
let refreshTimer: NodeJS.Timeout | null = null;

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const CHART_DEPTHS = new Set([
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25,
]);
const CHART_OPEN_POSITIONS = new Set(['UTG', 'MP', 'CO', 'BTN', 'SB']);

export function allHoldemHandClasses(): string[] {
  const hands: string[] = [];
  for (let row = 0; row < RANKS.length; row++) {
    for (let column = 0; column < RANKS.length; column++) {
      if (row === column) hands.push(`${RANKS[row]}${RANKS[column]}`);
      else if (row < column) hands.push(`${RANKS[row]}${RANKS[column]}s`);
      else hands.push(`${RANKS[column]}${RANKS[row]}o`);
    }
  }
  return hands;
}

const CHART_HAND_CLASSES = new Set(allHoldemHandClasses());

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate identity and every present sparse cell before a missing/malformed
 * value can be interpreted as a fold in a CHART_AUDITED policy.
 */
export function assertValidChartPolicyRow(row: ChartPolicyRow): ChartPolicyRow {
  if (
    !plainRecord(row) ||
    !['Cash', 'Tournament'].includes(row.game_type) ||
    !CHART_DEPTHS.has(row.stack_depth) ||
    !['fold_to_hero', 'sb_push'].includes(row.villain_action) ||
    !plainRecord(row.hand_matrix) ||
    Object.keys(row.hand_matrix).length === 0
  ) {
    throw new Error('invalid_chart_policy_row');
  }
  const expectedAction = row.villain_action === 'sb_push' ? 'call' : 'push';
  const expectedPosition =
    row.villain_action === 'sb_push'
      ? row.hero_position === 'BB'
      : CHART_OPEN_POSITIONS.has(row.hero_position);
  if (!expectedPosition) throw new Error('invalid_chart_policy_identity');

  for (const [hand, rawCell] of Object.entries(row.hand_matrix)) {
    if (!CHART_HAND_CLASSES.has(hand) || !plainRecord(rawCell)) {
      throw new Error(`invalid_chart_policy_cell:${hand}`);
    }
    const keys = Object.keys(rawCell);
    if (keys.length === 0 || keys.some((key) => key !== expectedAction && key !== 'fold')) {
      throw new Error(`invalid_chart_policy_actions:${hand}`);
    }
    const values = keys.map((key) => rawCell[key]);
    if (
      values.some(
        (value) =>
          value !== null &&
          (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
      )
    ) {
      throw new Error(`invalid_chart_policy_frequency:${hand}`);
    }
    const actionFrequency = rawCell[expectedAction];
    const foldFrequency = rawCell.fold;
    if (!Number.isFinite(actionFrequency) && !Number.isFinite(foldFrequency)) {
      throw new Error(`missing_chart_policy_frequency:${hand}`);
    }
    if (
      Number.isFinite(actionFrequency) &&
      Number.isFinite(foldFrequency) &&
      Math.abs((actionFrequency as number) + (foldFrequency as number) - 1) > 1e-6
    ) {
      throw new Error(`invalid_chart_policy_mix:${hand}`);
    }
  }
  return row;
}

function chartLookupKey(
  gameType: string,
  villainAction: string,
  position: string,
  depth: number
): string {
  return `${gameType}|${villainAction}|${position}|${depth}`;
}

function chartScenarioHash(row: ChartPolicyRow): string {
  return [
    'chart',
    row.game_type,
    row.villain_action,
    row.hero_position,
    String(row.stack_depth),
  ].join('|');
}

function decisionKeyForChart(row: ChartPolicyRow): SolverPolicyDecisionKey {
  const facing = row.villain_action.toLowerCase() === 'sb_push';
  const tournament = row.game_type.toLowerCase().includes('tournament');
  return {
    contractVersion: SOLVER_POLICY_CONTRACT_VERSION,
    variant: 'nlh',
    bettingStructure: 'no_limit',
    tableSize: facing ? 2 : null,
    positions: {
      hero: row.hero_position.toUpperCase(),
      villains: facing ? ['SB'] : [],
      button: 'UNKNOWN',
      smallBlind: 'UNKNOWN',
      bigBlind: 'UNKNOWN',
    },
    stackVector: [
      {
        seat: 0,
        position: row.hero_position.toUpperCase(),
        stackChips: null,
        stackBb: Number(row.stack_depth),
        committedChips: 0,
        active: true,
        allIn: false,
      },
      ...(facing
        ? [
            {
              seat: 1,
              position: 'SB',
              stackChips: null,
              stackBb: Number(row.stack_depth),
              committedChips: 0,
              active: true,
              allIn: false,
            },
          ]
        : []),
    ],
    blinds: {
      smallBlind: null,
      bigBlind: null,
      ante: 0,
      bigBlindAnte: 0,
      straddles: [],
      complete: false,
    },
    rake: {
      percent: null,
      capChips: null,
      capBb: null,
      noFlopNoDrop: false,
      complete: false,
    },
    tournamentUtility: {
      mode: tournament ? 'unknown' : 'cash',
      model: null,
      playersRemaining: null,
      entrants: null,
      handForHand: false,
      complete: false,
    },
    payouts: [],
    bounties: [],
    street: 'preflop',
    board: [],
    holding: [],
    publicActionHistory: { complete: false, actions: [] },
    legalActions: (facing ? ['call', 'fold'] : ['all_in', 'fold']).map((action) => ({
      action,
      minChips: null,
      maxChips: null,
      exactChips: null,
      allIn: action === 'all_in',
    })),
    sidePotEligibility: { complete: false, pots: [] },
  };
}

function normalizeMix(yes: number, fold: number): [number, number] {
  const safeYes = Number.isFinite(yes) && yes > 0 ? yes : 0;
  const safeFold = Number.isFinite(fold) && fold > 0 ? fold : 0;
  const total = safeYes + safeFold;
  return total > 0 ? [safeYes / total, safeFold / total] : [0, 1];
}

function finiteChartFrequency(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createChartSolverPolicy(row: ChartPolicyRow): SolverPolicyAnswer {
  assertValidChartPolicyRow(row);
  const facing = row.villain_action.toLowerCase() === 'sb_push';
  const yesId = facing ? 'call' : 'all_in';
  const yesSource = facing ? 'call' : 'push';
  const rangeDistribution: Record<string, Record<string, number>> = {};
  let yesTotal = 0;
  let foldTotal = 0;
  const hands = allHoldemHandClasses();
  for (const hand of hands) {
    const cell = row.hand_matrix[hand];
    const rawYes = finiteChartFrequency(cell?.[facing ? 'call' : 'push']);
    const rawFold = finiteChartFrequency(cell?.fold);
    const hasYes = rawYes !== null;
    const hasFold = rawFold !== null;
    const [yes, fold] = normalizeMix(
      hasYes ? rawYes : hasFold ? 1 - rawFold : 0,
      hasFold ? rawFold : hasYes ? 1 - rawYes : 1
    );
    rangeDistribution[hand] = { [yesId]: yes, fold };
    yesTotal += yes;
    foldTotal += fold;
  }
  // Match the producer's final whole-policy normalization exactly. Tiny IEEE
  // rounding differences are contract differences when artifacts are hashed.
  const [yesPolicyFrequency, foldPolicyFrequency] = normalizeMix(
    yesTotal / hands.length,
    foldTotal / hands.length
  );
  const actions: SolverPolicyAction[] = [
    {
      id: yesId,
      sourceCode: yesSource,
      family: yesId,
      label: facing ? 'Call' : 'All-In',
      frequency: yesPolicyFrequency,
      legal: true,
      size: facing
        ? { unit: 'none', chips: null, bigBlinds: null, potFraction: null, exact: false }
        : { unit: 'all_in', chips: null, bigBlinds: null, potFraction: null, exact: true },
      chipEvBb: null,
      tournamentUtilityEv: null,
    },
    {
      id: 'fold',
      sourceCode: 'fold',
      family: 'fold',
      label: 'Fold',
      frequency: foldPolicyFrequency,
      legal: true,
      size: { unit: 'none', chips: null, bigBlinds: null, potFraction: null, exact: false },
      chipEvBb: null,
      tournamentUtilityEv: null,
    },
  ];
  const key = decisionKeyForChart(row);
  const missing = solverPolicyKeyMissingDimensions(key);
  const scenarioHash = chartScenarioHash(row);
  const policy: SolverPolicyAnswer = {
    contractVersion: SOLVER_POLICY_CONTRACT_VERSION,
    policyVersion: SOLVER_POLICY_VERSION,
    key,
    kind: 'chart',
    node: {
      semantics: facing ? 'preflop_facing_wager' : 'preflop_unopened',
      sourceNode: row.villain_action,
      actor: row.hero_position.toUpperCase(),
      potBb: null,
      facingBetBb: facing ? Number(row.stack_depth) : 0,
    },
    actions,
    distribution: Object.fromEntries(actions.map((action) => [action.id, action.frequency])),
    legalSizes: actions
      .filter((action) => action.legal && action.size.unit !== 'none')
      .map((action) => ({ actionId: action.id, ...action.size })),
    chipEv: {
      unit: 'big_blinds',
      policy: null,
      byAction: Object.fromEntries(actions.map((action) => [action.id, null])),
      measuredByAction: false,
    },
    tournamentUtilityEv: {
      unit: 'utility',
      policy: null,
      byAction: Object.fromEntries(actions.map((action) => [action.id, null])),
      measuredByAction: false,
    },
    sourceArtifact: {
      system: 'memory_charts_gold',
      artifactId: row.chart_id || scenarioHash,
      scenarioHash,
      solverVersion: null,
      solverBinaryChecksum: null,
      machineId: null,
      pipelineCommit: null,
      manifestVersion: null,
      manifestChecksum: null,
      sourceArtifactChecksum: null,
      qualityStatus: 'audited_chart',
      auditedAt: row.created_at || null,
      provenanceComplete: true,
    },
    qualitySeal: 'CHART_AUDITED',
    validDomain: {
      completeKey: missing.length === 0,
      missingKeyDimensions: missing,
      exactMatchDimensions: ['heroPosition', 'holding', 'stackDepth', 'variant', 'villainAction'],
      approximatedDimensions: [],
      exclusions: ['no_postflop_use', 'no_unmodeled_action_lines'],
    },
    confidence: { score: 0.92, level: 'high' },
    fallbackReason: null,
    rangeDistribution,
  };
  const validation = validateSolverPolicyAnswer(policy);
  if (!validation.valid) throw new Error(`invalid_chart_policy:${validation.errors.join(',')}`);
  return deepFreezeSolverPolicy(policy);
}

function buildPolicyIndexes(bundle: SolverPolicyArtifactBundle): {
  byScenario: Map<string, SolverPolicyAnswer>;
  byKey: Map<string, SolverPolicyAnswer>;
} {
  const byScenario = new Map<string, SolverPolicyAnswer>();
  const byKey = new Map<string, SolverPolicyAnswer>();
  for (const sourcePolicy of bundle.policies) {
    const policy = deepFreezeSolverPolicy(structuredClone(sourcePolicy));
    const scenario = policy.sourceArtifact.scenarioHash;
    const key = stableSolverPolicyJson(policy.key);
    if (scenario && byScenario.has(scenario))
      throw new Error(`duplicate_scenario_hash:${scenario}`);
    if (byKey.has(key)) throw new Error('duplicate_decision_key');
    if (scenario) byScenario.set(scenario, policy);
    byKey.set(key, policy);
  }
  return { byScenario, byKey };
}

/** Validate the entire bundle before atomically replacing the live maps. */
export function replaceSolverPolicyArtifact(value: unknown): number {
  try {
    const validation = validateSolverPolicyArtifactBundle(value);
    if (!validation.valid || !validation.bundle) {
      throw new Error(`invalid_solver_policy_artifact:${validation.errors.join(',')}`);
    }
    const next = buildPolicyIndexes(validation.bundle);
    externalByScenario = next.byScenario;
    externalByKey = next.byKey;
    externalState = {
      configured: true,
      count: validation.bundle.policies.length,
      loadedAt: new Date().toISOString(),
      lastError: null,
      sourceArtifact: validation.bundle.sourceArtifact,
    };
    return validation.bundle.policies.length;
  } catch (error) {
    externalState = {
      ...externalState,
      configured: true,
      lastError: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

/** Build every chart policy before swapping, so a bad refresh keeps the last good set. */
export function hydrateChartPolicyArtifact(rows: ChartPolicyRow[]): number {
  try {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('empty_chart_policy_refresh');
    }
    const next = new Map<string, SolverPolicyAnswer>();
    for (const row of rows) {
      const policy = createChartSolverPolicy(row);
      const key = chartLookupKey(
        row.game_type,
        row.villain_action,
        row.hero_position,
        row.stack_depth
      );
      if (next.has(key)) throw new Error(`duplicate_chart_policy:${key}`);
      next.set(key, policy);
    }
    chartByLookup = next;
    chartState = {
      configured: true,
      count: next.size,
      loadedAt: new Date().toISOString(),
      lastError: null,
      sourceArtifact: 'memory_charts_gold',
    };
    return next.size;
  } catch (error) {
    chartState = {
      ...chartState,
      lastError: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

export function lookupSolverPolicy(args: {
  scenarioHash?: string;
  key?: SolverPolicyDecisionKey;
}): SolverPolicyAnswer | null {
  if (args.scenarioHash) {
    const byScenario = externalByScenario.get(args.scenarioHash);
    if (byScenario) return byScenario;
  }
  return args.key ? externalByKey.get(stableSolverPolicyJson(args.key)) || null : null;
}

export function lookupChartPolicy(args: {
  gameType: string;
  villainAction: string;
  position: string;
  depth: number;
}): SolverPolicyAnswer | null {
  return (
    chartByLookup.get(
      chartLookupKey(args.gameType, args.villainAction, args.position, args.depth)
    ) || null
  );
}

export function lookupChartPolicyAdvice(args: {
  gameType: string;
  villainAction: string;
  position: string;
  depth: number;
  hand: string;
}): ChartPolicyAdvice | null {
  const policy = lookupChartPolicy(args);
  if (!policy) return null;
  const mix = policy.rangeDistribution?.[args.hand];
  if (!mix) return null;
  const actions = policy.actions
    .map((action) => ({ action, frequency: Number(mix[action.id]) || 0 }))
    .sort((a, b) => b.frequency - a.frequency || a.action.id.localeCompare(b.action.id));
  const best = actions[0];
  if (!best) return null;
  return {
    action: best.action.sourceCode || best.action.id,
    freq: best.frequency,
    chart:
      policy.sourceArtifact.scenarioHash ||
      chartLookupKey(args.gameType, args.villainAction, args.position, args.depth),
    policy,
  };
}

export function loadSolverPolicyArtifactFile(filePath: string): number {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return replaceSolverPolicyArtifact(parsed);
  } catch (error) {
    externalState = {
      ...externalState,
      configured: true,
      lastError: error instanceof Error ? error.message : String(error),
      sourceArtifact: basename(filePath),
    };
    throw error;
  }
}

export function loadConfiguredSolverPolicyArtifact(): number {
  const filePath = process.env.SOLVER_POLICY_ARTIFACT_PATH;
  if (!filePath) {
    externalByScenario = new Map();
    externalByKey = new Map();
    externalState = {
      configured: false,
      count: 0,
      loadedAt: null,
      lastError: null,
      sourceArtifact: null,
    };
    return 0;
  }
  return loadSolverPolicyArtifactFile(filePath);
}

export function startSolverPolicyArtifactLoader(): void {
  if (refreshTimer) return;
  try {
    const count = loadConfiguredSolverPolicyArtifact();
    if (externalState.configured)
      console.log(`[SolverPolicyArtifact] ${count} policies loaded from disk`);
    else
      console.log(
        '[SolverPolicyArtifact] no external file configured; chart artifact will hydrate from memory_charts_gold'
      );
  } catch (error) {
    console.warn(
      `[SolverPolicyArtifact] initial file load failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (process.env.SOLVER_POLICY_ARTIFACT_PATH) {
    refreshTimer = setInterval(() => {
      try {
        loadConfiguredSolverPolicyArtifact();
      } catch (error) {
        console.warn(
          `[SolverPolicyArtifact] file refresh failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }, 5 * 60_000);
    refreshTimer.unref?.();
  }
}

export function stopSolverPolicyArtifactLoader(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

export function solverPolicyArtifactCount(): number {
  return externalState.count + chartState.count;
}

export function solverPolicyArtifactStatus() {
  return {
    contractVersion: SOLVER_POLICY_CONTRACT_VERSION,
    policyVersion: SOLVER_POLICY_VERSION,
    schemaSha256: SOLVER_POLICY_SCHEMA_SHA256,
    actionClockSource: 'memory_only' as const,
    external: { ...externalState },
    charts: { ...chartState },
    totalPolicies: solverPolicyArtifactCount(),
  };
}

/** Surface corpus/query failures that happen before artifact hydration. */
export function recordChartPolicyRefreshError(error: unknown): void {
  chartState = {
    ...chartState,
    lastError: error instanceof Error ? error.message : String(error),
  };
}

export function _clearSolverPolicyArtifactsForTests(): void {
  externalByScenario = new Map();
  externalByKey = new Map();
  chartByLookup = new Map();
  externalState = {
    configured: false,
    count: 0,
    loadedAt: null,
    lastError: null,
    sourceArtifact: null,
  };
  chartState = {
    configured: true,
    count: 0,
    loadedAt: null,
    lastError: null,
    sourceArtifact: 'memory_charts_gold',
  };
  stopSolverPolicyArtifactLoader();
}

export function _clearChartPolicyArtifactsForTests(): void {
  chartByLookup = new Map();
  chartState = {
    configured: true,
    count: 0,
    loadedAt: null,
    lastError: null,
    sourceArtifact: 'memory_charts_gold',
  };
}
