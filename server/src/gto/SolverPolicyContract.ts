/** Versioned solver-policy contract consumed by the Club Arena engine. */

export const SOLVER_POLICY_CONTRACT_VERSION = 'smarter-poker.solver-policy.v1' as const;
export const SOLVER_POLICY_VERSION = 'solver-policy-service.1.0.1' as const;
export const SOLVER_POLICY_SCHEMA_SHA256 =
  'e18b456ed15165e2c0c640b606af12a0003c02be4ee8fe9cb15c54a56117aa9c' as const;

export type SolverPolicyKind =
  | 'exact'
  | 'aggregated'
  | 'derived'
  | 'chart'
  | 'curated'
  | 'heuristic'
  | 'unavailable';

export type SolverQualitySeal =
  | 'SOLVER_EXACT'
  | 'SOLVER_AGGREGATED'
  | 'SOLVER_DERIVED_RESPONSE'
  | 'CHART_AUDITED'
  | 'CURATED'
  | 'HEURISTIC'
  | 'LEGACY_UNVERIFIED'
  | 'UNAVAILABLE';

export type SolverNodeSemantics =
  | 'check_or_bet'
  | 'facing_wager'
  | 'preflop_unopened'
  | 'preflop_facing_wager'
  | 'terminal'
  | 'unknown';

export interface SolverPolicyActionSize {
  unit: 'none' | 'unknown' | 'chips' | 'big_blinds' | 'pot_fraction' | 'all_in';
  chips: number | null;
  bigBlinds: number | null;
  potFraction: number | null;
  exact: boolean;
}

export interface SolverPolicyAction {
  id: string;
  sourceCode: string | null;
  family: string;
  label: string;
  frequency: number;
  legal: boolean;
  size: SolverPolicyActionSize;
  chipEvBb: number | null;
  tournamentUtilityEv: number | null;
}

export interface SolverPolicyDecisionKey {
  contractVersion: typeof SOLVER_POLICY_CONTRACT_VERSION;
  variant: string;
  bettingStructure: string;
  tableSize: number | null;
  positions: {
    hero: string;
    villains: string[];
    button: string;
    smallBlind: string;
    bigBlind: string;
  };
  stackVector: Array<{
    seat: number;
    position: string;
    stackChips: number | null;
    stackBb: number | null;
    committedChips: number;
    active: boolean;
    allIn: boolean;
  }>;
  blinds: {
    smallBlind: number | null;
    bigBlind: number | null;
    ante: number;
    bigBlindAnte: number;
    straddles: Array<{ seat: number; amount: number | null }>;
    complete: boolean;
  };
  rake: {
    percent: number | null;
    capChips: number | null;
    capBb: number | null;
    noFlopNoDrop: boolean;
    complete: boolean;
  };
  tournamentUtility: {
    mode: string;
    model: string | null;
    playersRemaining: number | null;
    entrants: number | null;
    handForHand: boolean;
    complete: boolean;
  };
  payouts: Array<{ place: number; amount: number | null; type: string }>;
  bounties: Array<{ place: number; amount: number | null; type: string }>;
  street: 'preflop' | 'flop' | 'turn' | 'river';
  board: string[];
  holding: string[];
  publicActionHistory: {
    complete: boolean;
    actions: Array<{
      sequence: number;
      street: 'preflop' | 'flop' | 'turn' | 'river';
      actor: string;
      action: string;
      amountChips: number | null;
      amountBb: number | null;
      allIn: boolean;
    }>;
  };
  legalActions: Array<{
    action: string;
    minChips: number | null;
    maxChips: number | null;
    exactChips: number | null;
    allIn: boolean;
  }>;
  sidePotEligibility: {
    complete: boolean;
    pots: Array<{
      id: string;
      amountChips: number | null;
      eligibleSeats: number[];
      heroEligible: boolean;
    }>;
  };
}

export interface SolverPolicyAnswer {
  contractVersion: typeof SOLVER_POLICY_CONTRACT_VERSION;
  policyVersion: string;
  key: SolverPolicyDecisionKey;
  kind: SolverPolicyKind;
  node: {
    semantics: SolverNodeSemantics;
    sourceNode: string | null;
    actor: string;
    potBb: number | null;
    facingBetBb: number | null;
  };
  actions: SolverPolicyAction[];
  distribution: Record<string, number>;
  legalSizes: Array<SolverPolicyActionSize & { actionId: string }>;
  chipEv: {
    unit: 'big_blinds';
    policy: number | null;
    byAction: Record<string, number | null>;
    measuredByAction: boolean;
  };
  tournamentUtilityEv: {
    unit: string;
    policy: number | null;
    byAction: Record<string, number | null>;
    measuredByAction: boolean;
  };
  sourceArtifact: {
    system: string;
    artifactId: string | null;
    scenarioHash: string | null;
    solverVersion: string | null;
    solverBinaryChecksum: string | null;
    machineId: string | null;
    pipelineCommit: string | null;
    manifestVersion: string | null;
    manifestChecksum: string | null;
    sourceArtifactChecksum: string | null;
    qualityStatus: string | null;
    auditedAt: string | null;
    provenanceComplete: boolean;
  };
  qualitySeal: SolverQualitySeal;
  validDomain: {
    completeKey: boolean;
    missingKeyDimensions: string[];
    exactMatchDimensions: string[];
    approximatedDimensions: string[];
    exclusions: string[];
  };
  confidence: { score: number; level: 'none' | 'low' | 'medium' | 'high' };
  fallbackReason: string | null;
  rangeDistribution: Record<string, Record<string, number>> | null;
}

export interface SolverPolicyArtifactBundle {
  contractVersion: typeof SOLVER_POLICY_CONTRACT_VERSION;
  schemaSha256: typeof SOLVER_POLICY_SCHEMA_SHA256;
  policyVersion: string;
  generatedAt: string;
  sourceArtifact: string;
  policies: SolverPolicyAnswer[];
}

const POLICY_KINDS = new Set<SolverPolicyKind>([
  'exact',
  'aggregated',
  'derived',
  'chart',
  'curated',
  'heuristic',
  'unavailable',
]);
const QUALITY_SEALS = new Set<SolverQualitySeal>([
  'SOLVER_EXACT',
  'SOLVER_AGGREGATED',
  'SOLVER_DERIVED_RESPONSE',
  'CHART_AUDITED',
  'CURATED',
  'HEURISTIC',
  'LEGACY_UNVERIFIED',
  'UNAVAILABLE',
]);
const QUALITY_SEALS_BY_KIND: Record<SolverPolicyKind, ReadonlySet<SolverQualitySeal>> = {
  exact: new Set(['SOLVER_EXACT']),
  aggregated: new Set(['SOLVER_AGGREGATED']),
  derived: new Set(['SOLVER_DERIVED_RESPONSE', 'LEGACY_UNVERIFIED']),
  chart: new Set(['CHART_AUDITED']),
  curated: new Set(['CURATED']),
  heuristic: new Set(['HEURISTIC']),
  unavailable: new Set(['UNAVAILABLE']),
};
const NODE_SEMANTICS = new Set<SolverNodeSemantics>([
  'check_or_bet',
  'facing_wager',
  'preflop_unopened',
  'preflop_facing_wager',
  'terminal',
  'unknown',
]);
const STREETS = new Set(['preflop', 'flop', 'turn', 'river']);
const SIZE_UNITS = new Set(['none', 'unknown', 'chips', 'big_blinds', 'pot_fraction', 'all_in']);
const CARD_RE = /^[2-9TJQKA][cdhs]$/;

function object(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function nonNegativeOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function exactActionSizeIsComplete(action: SolverPolicyAction): boolean {
  if (!action?.legal || !object(action?.size)) return false;
  const { family, size } = action;
  if (family === 'all_in') {
    if (size.unit !== 'all_in' || size.exact !== true) return false;
    return [size.chips, size.bigBlinds, size.potFraction].every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    );
  }
  if (family === 'bet' || family === 'raise') {
    if (size.exact !== true || !['chips', 'big_blinds', 'pot_fraction'].includes(size.unit)) {
      return false;
    }
    return [size.chips, size.bigBlinds, size.potFraction].every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    );
  }
  if (!['fold', 'check', 'call'].includes(family)) return false;
  return (
    size.unit === 'none' &&
    size.exact === false &&
    size.chips === null &&
    size.bigBlinds === null &&
    size.potFraction === null
  );
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-6 * Math.max(1, Math.abs(left), Math.abs(right));
}

/**
 * Exact aggressive actions carry all three sizing units so every consumer can
 * execute the same amount without guessing which stack/pot convention was
 * used by the producer. Reject internally inconsistent unit conversions.
 */
function exactActionUnitsAreConsistent(
  action: SolverPolicyAction,
  key: SolverPolicyDecisionKey,
  node: SolverPolicyAnswer['node']
): boolean {
  if (!['bet', 'raise', 'all_in'].includes(action?.family)) return true;
  if (!exactActionSizeIsComplete(action)) return false;
  const bigBlindChips = key?.blinds?.bigBlind;
  const potBb = node?.potBb;
  if (
    !(typeof bigBlindChips === 'number' && Number.isFinite(bigBlindChips) && bigBlindChips > 0) ||
    !(typeof potBb === 'number' && Number.isFinite(potBb) && potBb > 0)
  ) {
    return false;
  }
  return (
    nearlyEqual(action.size.chips! / bigBlindChips, action.size.bigBlinds!) &&
    nearlyEqual(action.size.bigBlinds! / potBb, action.size.potFraction!)
  );
}

function exactActionIsLegalForKey(
  action: SolverPolicyAction,
  key: SolverPolicyDecisionKey
): boolean {
  const candidates = Array.isArray(key?.legalActions)
    ? key.legalActions.filter(
        (entry) =>
          entry?.action === action?.family || (action?.family === 'all_in' && entry?.allIn === true)
      )
    : [];
  if (candidates.length === 0) return false;
  if (!['bet', 'raise', 'all_in'].includes(action?.family)) return true;
  if (typeof action?.size?.chips !== 'number') return false;
  return candidates.some((entry) => {
    const chips = action.size.chips as number;
    if (typeof entry.exactChips === 'number') return Math.abs(entry.exactChips - chips) <= 1e-9;
    if (typeof entry.minChips === 'number' && chips < entry.minChips) return false;
    if (typeof entry.maxChips === 'number' && chips > entry.maxChips) return false;
    return true;
  });
}

function exactNodeIsConsistent(
  node: SolverPolicyAnswer['node'],
  key: SolverPolicyDecisionKey
): boolean {
  if (
    !object(node) ||
    node.actor !== key?.positions?.hero ||
    !(typeof node.potBb === 'number' && Number.isFinite(node.potBb) && node.potBb > 0) ||
    !(
      typeof node.facingBetBb === 'number' &&
      Number.isFinite(node.facingBetBb) &&
      node.facingBetBb >= 0
    )
  )
    return false;
  const facing = node.facingBetBb > 0;
  const expected: SolverNodeSemantics =
    key?.street === 'preflop'
      ? facing
        ? 'preflop_facing_wager'
        : 'preflop_unopened'
      : facing
        ? 'facing_wager'
        : 'check_or_bet';
  return node.semantics === expected;
}

function exactDomainIsConsistent(value: SolverPolicyAnswer['validDomain']): boolean {
  return (
    object(value) &&
    Array.isArray(value.exactMatchDimensions) &&
    value.exactMatchDimensions.length === 1 &&
    value.exactMatchDimensions[0] === 'all' &&
    Array.isArray(value.approximatedDimensions) &&
    value.approximatedDimensions.length === 0 &&
    Array.isArray(value.exclusions) &&
    value.exclusions.length === 0
  );
}

function exactObjectKeys(value: unknown, keys: string[]): boolean {
  if (!object(value)) return false;
  const expected = new Set(keys);
  return (
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

export function stableSolverPolicyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSolverPolicyJson).join(',')}]`;
  if (object(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSolverPolicyJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function solverPolicyKeyMissingDimensions(key: SolverPolicyDecisionKey): string[] {
  const missing: string[] = [];
  const shapeErrors: string[] = [];
  validateDecisionKey(key, shapeErrors);
  if (shapeErrors.length > 0) missing.push('keyShape');
  if (key?.contractVersion !== SOLVER_POLICY_CONTRACT_VERSION) missing.push('contractVersion');
  if (!key?.variant || key.variant === 'unknown') missing.push('variant');
  if (!key?.bettingStructure || key.bettingStructure === 'unknown')
    missing.push('bettingStructure');
  if (!Number.isInteger(key?.tableSize) || Number(key.tableSize) < 2) missing.push('tableSize');
  if (!key?.positions?.hero || key.positions.hero === 'UNKNOWN') missing.push('positions.hero');
  if (
    !key?.positions?.button ||
    key.positions.button === 'UNKNOWN' ||
    !key?.positions?.smallBlind ||
    key.positions.smallBlind === 'UNKNOWN' ||
    !key?.positions?.bigBlind ||
    key.positions.bigBlind === 'UNKNOWN' ||
    !Array.isArray(key?.positions?.villains) ||
    key.positions.villains.length === 0 ||
    key.positions.villains.some((position) => !position || position === 'UNKNOWN')
  ) {
    missing.push('positions.table');
  }
  if (
    !Array.isArray(key?.stackVector) ||
    key.stackVector.length < 2 ||
    (Number.isInteger(key?.tableSize) && key.stackVector.length !== key.tableSize) ||
    key.stackVector.some((entry) => {
      const hasChips = typeof entry?.stackChips === 'number' && Number.isFinite(entry.stackChips);
      const hasBigBlinds = typeof entry?.stackBb === 'number' && Number.isFinite(entry.stackBb);
      return (
        (!hasChips && !hasBigBlinds) ||
        (hasChips && Number(entry.stackChips) < 0) ||
        (hasBigBlinds && Number(entry.stackBb) < 0)
      );
    })
  )
    missing.push('stackVector');
  if (key?.blinds?.complete !== true || !(Number(key?.blinds?.bigBlind) > 0))
    missing.push('blinds');
  if (key?.rake?.complete !== true) missing.push('rake');
  if (!STREETS.has(key?.street)) missing.push('street');
  const boardCount: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
  if (!Array.isArray(key?.board) || key.board.length !== boardCount[key?.street])
    missing.push('board');
  const holdingCount: Record<string, number> = {
    nlh: 2,
    short_deck: 2,
    pineapple: 3,
    plo4: 4,
    plo5: 5,
    plo6: 6,
    plo8: 4,
  };
  if (
    !Array.isArray(key?.holding) ||
    !holdingCount[key?.variant] ||
    key.holding.length !== holdingCount[key.variant]
  )
    missing.push('holding');
  const cards = [...(key?.board || []), ...(key?.holding || [])];
  if (new Set(cards).size !== cards.length) missing.push('cardUniqueness');
  if (
    key?.publicActionHistory?.complete !== true ||
    (key?.street !== 'preflop' && key?.publicActionHistory?.actions?.length === 0)
  )
    missing.push('publicActionHistory');
  if (!Array.isArray(key?.legalActions) || key.legalActions.length === 0)
    missing.push('legalActions');
  if (key?.sidePotEligibility?.complete !== true) missing.push('sidePotEligibility');
  if (key?.tournamentUtility?.complete !== true) missing.push('tournamentUtility');
  if (key?.tournamentUtility?.mode !== 'cash') {
    if (!Array.isArray(key?.payouts) || key.payouts.length === 0) missing.push('payouts');
  }
  return missing;
}

function exactSourceComplete(source: unknown): boolean {
  if (!object(source)) return false;
  const text = (value: unknown): string => String(value ?? '').trim();
  return (
    source.provenanceComplete === true &&
    Boolean(text(source.system)) &&
    text(source.system).toLowerCase() !== 'none' &&
    !/v1(?!\d)/i.test(text(source.system)) &&
    Boolean(text(source.artifactId)) &&
    Boolean(text(source.scenarioHash)) &&
    Boolean(text(source.solverVersion)) &&
    /^[0-9a-f]{64}$/i.test(text(source.solverBinaryChecksum)) &&
    Boolean(text(source.machineId)) &&
    /^[0-9a-f]{40}$/i.test(text(source.pipelineCommit)) &&
    Boolean(text(source.manifestVersion)) &&
    /^[0-9a-f]{64}$/i.test(text(source.manifestChecksum)) &&
    /^[0-9a-f]{64}$/i.test(text(source.sourceArtifactChecksum)) &&
    text(source.qualityStatus).toLowerCase() === 'validated' &&
    Number.isFinite(Date.parse(text(source.auditedAt)))
  );
}

function decisionKeyRelationshipsAreValid(key: Record<string, any>): boolean {
  const stack = Array.isArray(key.stackVector) ? key.stackVector : [];
  const seats = new Set(stack.map((entry: any) => entry?.seat));
  const positions = new Set(stack.map((entry: any) => entry?.position));
  const bigBlind = key.blinds?.bigBlind;
  const unitPairIsValid = (chips: unknown, bigBlinds: unknown): boolean => {
    if (chips === null || bigBlinds === null) return true;
    return (
      typeof chips === 'number' &&
      Number.isFinite(chips) &&
      typeof bigBlinds === 'number' &&
      Number.isFinite(bigBlinds) &&
      typeof bigBlind === 'number' &&
      Number.isFinite(bigBlind) &&
      bigBlind > 0 &&
      nearlyEqual(chips / bigBlind, bigBlinds)
    );
  };
  if (stack.some((entry: any) => !unitPairIsValid(entry?.stackChips, entry?.stackBb))) return false;
  if (!unitPairIsValid(key.rake?.capChips, key.rake?.capBb)) return false;
  if (typeof key.rake?.percent === 'number' && key.rake.percent > 100) return false;
  if (
    typeof key.blinds?.smallBlind === 'number' &&
    typeof bigBlind === 'number' &&
    key.blinds.smallBlind > bigBlind
  )
    return false;
  if (
    key.tournamentUtility?.playersRemaining !== null &&
    !Number.isInteger(key.tournamentUtility?.playersRemaining)
  )
    return false;
  if (
    key.tournamentUtility?.entrants !== null &&
    !Number.isInteger(key.tournamentUtility?.entrants)
  )
    return false;

  const known = (position: unknown): position is string =>
    typeof position === 'string' && position !== 'UNKNOWN';
  if (known(key.positions?.hero) && !positions.has(key.positions.hero)) return false;
  const villains = Array.isArray(key.positions?.villains) ? key.positions.villains : [];
  if (villains.some((position: unknown) => known(position) && !positions.has(position)))
    return false;
  const uniqueKnownPositions = stack.map((entry: any) => entry?.position).filter(known);
  if (new Set(uniqueKnownPositions).size !== uniqueKnownPositions.length) return false;

  const straddles = Array.isArray(key.blinds?.straddles) ? key.blinds.straddles : [];
  if (
    straddles.some((entry: any) => !seats.has(entry?.seat)) ||
    new Set(straddles.map((entry: any) => entry?.seat)).size !== straddles.length
  )
    return false;

  const streetIndex: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };
  const history = Array.isArray(key.publicActionHistory?.actions)
    ? key.publicActionHistory.actions
    : [];
  let priorStreet = -1;
  for (const action of history) {
    const actionStreet = streetIndex[action?.street];
    if (
      !Number.isInteger(actionStreet) ||
      actionStreet < priorStreet ||
      actionStreet > streetIndex[key.street] ||
      !unitPairIsValid(action?.amountChips, action?.amountBb)
    )
      return false;
    priorStreet = actionStreet;
  }

  const pots = Array.isArray(key.sidePotEligibility?.pots) ? key.sidePotEligibility.pots : [];
  if (new Set(pots.map((pot: any) => pot?.id)).size !== pots.length) return false;
  const heroSeats = stack
    .filter((entry: any) => entry?.position === key.positions?.hero)
    .map((entry: any) => entry.seat);
  for (const pot of pots) {
    const eligibleSeats = Array.isArray(pot?.eligibleSeats) ? pot.eligibleSeats : [];
    if (
      !Array.isArray(pot?.eligibleSeats) ||
      new Set(eligibleSeats).size !== eligibleSeats.length ||
      eligibleSeats.some((seat: unknown) => !seats.has(seat))
    )
      return false;
    if (heroSeats.length === 1 && pot?.heroEligible !== eligibleSeats.includes(heroSeats[0]))
      return false;
  }
  for (const vector of [
    Array.isArray(key.payouts) ? key.payouts : [],
    Array.isArray(key.bounties) ? key.bounties : [],
  ]) {
    if (new Set(vector.map((entry: any) => entry?.place)).size !== vector.length) return false;
  }
  return true;
}

function validateDecisionKey(value: unknown, errors: string[]): value is SolverPolicyDecisionKey {
  if (!object(value)) {
    errors.push('key');
    return false;
  }
  if (
    !exactObjectKeys(value, [
      'contractVersion',
      'variant',
      'bettingStructure',
      'tableSize',
      'positions',
      'stackVector',
      'blinds',
      'rake',
      'tournamentUtility',
      'payouts',
      'bounties',
      'street',
      'board',
      'holding',
      'publicActionHistory',
      'legalActions',
      'sidePotEligibility',
    ])
  )
    errors.push('key.shape');
  if (value.contractVersion !== SOLVER_POLICY_CONTRACT_VERSION) errors.push('key.contractVersion');
  if (typeof value.variant !== 'string') errors.push('key.variant');
  if (typeof value.bettingStructure !== 'string') errors.push('key.bettingStructure');
  if (!(value.tableSize === null || (Number.isInteger(value.tableSize) && value.tableSize >= 2))) {
    errors.push('key.tableSize');
  }
  if (
    !object(value.positions) ||
    typeof value.positions.hero !== 'string' ||
    !strings(value.positions.villains) ||
    typeof value.positions.button !== 'string' ||
    typeof value.positions.smallBlind !== 'string' ||
    typeof value.positions.bigBlind !== 'string' ||
    !exactObjectKeys(value.positions, ['hero', 'villains', 'button', 'smallBlind', 'bigBlind'])
  ) {
    errors.push('key.positions');
  }
  if (
    !Array.isArray(value.stackVector) ||
    value.stackVector.some(
      (entry) =>
        !object(entry) ||
        !Number.isInteger(entry.seat) ||
        entry.seat < 0 ||
        typeof entry.position !== 'string' ||
        !nonNegativeOrNull(entry.stackChips) ||
        !nonNegativeOrNull(entry.stackBb) ||
        !Number.isFinite(entry.committedChips) ||
        entry.committedChips < 0 ||
        typeof entry.active !== 'boolean' ||
        typeof entry.allIn !== 'boolean' ||
        !exactObjectKeys(entry, [
          'seat',
          'position',
          'stackChips',
          'stackBb',
          'committedChips',
          'active',
          'allIn',
        ])
    ) ||
    new Set(value.stackVector.map((entry: any) => entry?.seat)).size !== value.stackVector.length
  )
    errors.push('key.stackVector');
  if (
    !object(value.blinds) ||
    !nonNegativeOrNull(value.blinds.smallBlind) ||
    !nonNegativeOrNull(value.blinds.bigBlind) ||
    !Number.isFinite(value.blinds.ante) ||
    value.blinds.ante < 0 ||
    !Number.isFinite(value.blinds.bigBlindAnte) ||
    value.blinds.bigBlindAnte < 0 ||
    !Array.isArray(value.blinds.straddles) ||
    value.blinds.straddles.some(
      (entry: unknown) =>
        !object(entry) ||
        !Number.isInteger(entry.seat) ||
        entry.seat < 0 ||
        !nonNegativeOrNull(entry.amount) ||
        !exactObjectKeys(entry, ['seat', 'amount'])
    ) ||
    typeof value.blinds.complete !== 'boolean' ||
    !exactObjectKeys(value.blinds, [
      'smallBlind',
      'bigBlind',
      'ante',
      'bigBlindAnte',
      'straddles',
      'complete',
    ])
  )
    errors.push('key.blinds');
  if (
    !object(value.rake) ||
    !nonNegativeOrNull(value.rake.percent) ||
    !nonNegativeOrNull(value.rake.capChips) ||
    !nonNegativeOrNull(value.rake.capBb) ||
    typeof value.rake.noFlopNoDrop !== 'boolean' ||
    typeof value.rake.complete !== 'boolean' ||
    !exactObjectKeys(value.rake, ['percent', 'capChips', 'capBb', 'noFlopNoDrop', 'complete'])
  )
    errors.push('key.rake');
  if (
    !object(value.tournamentUtility) ||
    typeof value.tournamentUtility.mode !== 'string' ||
    !(
      typeof value.tournamentUtility.model === 'string' || value.tournamentUtility.model === null
    ) ||
    !nonNegativeOrNull(value.tournamentUtility.playersRemaining) ||
    !nonNegativeOrNull(value.tournamentUtility.entrants) ||
    (value.tournamentUtility.playersRemaining !== null &&
      value.tournamentUtility.entrants !== null &&
      value.tournamentUtility.playersRemaining > value.tournamentUtility.entrants) ||
    typeof value.tournamentUtility.handForHand !== 'boolean' ||
    typeof value.tournamentUtility.complete !== 'boolean' ||
    !exactObjectKeys(value.tournamentUtility, [
      'mode',
      'model',
      'playersRemaining',
      'entrants',
      'handForHand',
      'complete',
    ])
  )
    errors.push('key.tournamentUtility');
  const invalidMoney = (entry: unknown) =>
    !object(entry) ||
    !Number.isInteger(entry.place) ||
    entry.place < 1 ||
    !nonNegativeOrNull(entry.amount) ||
    typeof entry.type !== 'string' ||
    !exactObjectKeys(entry, ['place', 'amount', 'type']);
  if (
    !Array.isArray(value.payouts) ||
    value.payouts.some(invalidMoney) ||
    !Array.isArray(value.bounties) ||
    value.bounties.some(invalidMoney)
  )
    errors.push('key.money');
  if (!STREETS.has(value.street)) errors.push('key.street');
  if (!Array.isArray(value.board) || value.board.some((card) => !CARD_RE.test(card)))
    errors.push('key.board');
  if (!Array.isArray(value.holding) || value.holding.some((card) => !CARD_RE.test(card)))
    errors.push('key.holding');
  if (
    Array.isArray(value.board) &&
    Array.isArray(value.holding) &&
    new Set([...value.board, ...value.holding]).size !== value.board.length + value.holding.length
  )
    errors.push('key.cardUniqueness');
  if (
    !object(value.publicActionHistory) ||
    typeof value.publicActionHistory.complete !== 'boolean' ||
    !Array.isArray(value.publicActionHistory.actions) ||
    value.publicActionHistory.actions.some(
      (entry: unknown) =>
        !object(entry) ||
        !Number.isInteger(entry.sequence) ||
        entry.sequence < 0 ||
        !STREETS.has(entry.street) ||
        typeof entry.actor !== 'string' ||
        typeof entry.action !== 'string' ||
        !nonNegativeOrNull(entry.amountChips) ||
        !nonNegativeOrNull(entry.amountBb) ||
        typeof entry.allIn !== 'boolean' ||
        !exactObjectKeys(entry, [
          'sequence',
          'street',
          'actor',
          'action',
          'amountChips',
          'amountBb',
          'allIn',
        ])
    ) ||
    value.publicActionHistory.actions.some(
      (entry: any, index: number, actions: any[]) =>
        index > 0 && entry?.sequence <= actions[index - 1]?.sequence
    ) ||
    !exactObjectKeys(value.publicActionHistory, ['complete', 'actions'])
  ) {
    errors.push('key.publicActionHistory');
  }
  if (
    !Array.isArray(value.legalActions) ||
    value.legalActions.some((entry: unknown) => {
      if (
        !object(entry) ||
        typeof entry.action !== 'string' ||
        !nonNegativeOrNull(entry.minChips) ||
        !nonNegativeOrNull(entry.maxChips) ||
        !nonNegativeOrNull(entry.exactChips) ||
        typeof entry.allIn !== 'boolean' ||
        !exactObjectKeys(entry, ['action', 'minChips', 'maxChips', 'exactChips', 'allIn'])
      )
        return true;
      if (entry.minChips !== null && entry.maxChips !== null && entry.minChips > entry.maxChips)
        return true;
      return Boolean(
        entry.exactChips !== null &&
        ((entry.minChips !== null && entry.exactChips < entry.minChips) ||
          (entry.maxChips !== null && entry.exactChips > entry.maxChips))
      );
    })
  ) {
    errors.push('key.legalActions');
  }
  if (
    !object(value.sidePotEligibility) ||
    typeof value.sidePotEligibility.complete !== 'boolean' ||
    !Array.isArray(value.sidePotEligibility.pots) ||
    value.sidePotEligibility.pots.some(
      (entry: unknown) =>
        !object(entry) ||
        typeof entry.id !== 'string' ||
        !nonNegativeOrNull(entry.amountChips) ||
        !Array.isArray(entry.eligibleSeats) ||
        entry.eligibleSeats.some((seat: unknown) => !Number.isInteger(seat) || Number(seat) < 0) ||
        typeof entry.heroEligible !== 'boolean' ||
        !exactObjectKeys(entry, ['id', 'amountChips', 'eligibleSeats', 'heroEligible'])
    ) ||
    !exactObjectKeys(value.sidePotEligibility, ['complete', 'pots'])
  ) {
    errors.push('key.sidePotEligibility');
  }
  if (!decisionKeyRelationshipsAreValid(value)) errors.push('key.relationships');
  return errors.length === 0;
}

function validateAction(
  value: unknown,
  errors: string[],
  index: number
): value is SolverPolicyAction {
  const prefix = `actions.${index}`;
  if (!object(value)) {
    errors.push(prefix);
    return false;
  }
  if (
    !exactObjectKeys(value, [
      'id',
      'sourceCode',
      'family',
      'label',
      'frequency',
      'legal',
      'size',
      'chipEvBb',
      'tournamentUtilityEv',
    ])
  )
    errors.push(`${prefix}.shape`);
  if (typeof value.id !== 'string' || !value.id) errors.push(`${prefix}.id`);
  if (!(typeof value.sourceCode === 'string' || value.sourceCode === null))
    errors.push(`${prefix}.sourceCode`);
  if (typeof value.family !== 'string' || !value.family) errors.push(`${prefix}.family`);
  if (typeof value.label !== 'string' || !value.label) errors.push(`${prefix}.label`);
  if (!Number.isFinite(value.frequency) || value.frequency < 0 || value.frequency > 1)
    errors.push(`${prefix}.frequency`);
  if (typeof value.legal !== 'boolean') errors.push(`${prefix}.legal`);
  if (
    !object(value.size) ||
    !SIZE_UNITS.has(value.size.unit) ||
    !nonNegativeOrNull(value.size.chips) ||
    !nonNegativeOrNull(value.size.bigBlinds) ||
    !nonNegativeOrNull(value.size.potFraction) ||
    typeof value.size.exact !== 'boolean' ||
    !exactObjectKeys(value.size, ['unit', 'chips', 'bigBlinds', 'potFraction', 'exact'])
  ) {
    errors.push(`${prefix}.size`);
  }
  if (!finiteOrNull(value.chipEvBb)) errors.push(`${prefix}.chipEvBb`);
  if (!finiteOrNull(value.tournamentUtilityEv)) errors.push(`${prefix}.tournamentUtilityEv`);
  return true;
}

export function validateSolverPolicyAnswer(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!object(value)) return { valid: false, errors: ['answer'] };
  if (
    !exactObjectKeys(value, [
      'contractVersion',
      'policyVersion',
      'key',
      'kind',
      'node',
      'actions',
      'distribution',
      'legalSizes',
      'chipEv',
      'tournamentUtilityEv',
      'sourceArtifact',
      'qualitySeal',
      'validDomain',
      'confidence',
      'fallbackReason',
      'rangeDistribution',
    ])
  )
    errors.push('answer.shape');
  if (value.contractVersion !== SOLVER_POLICY_CONTRACT_VERSION) errors.push('contractVersion');
  if (typeof value.policyVersion !== 'string' || !value.policyVersion) errors.push('policyVersion');
  if (!POLICY_KINDS.has(value.kind)) errors.push('kind');
  validateDecisionKey(value.key, errors);
  if (
    !object(value.node) ||
    !NODE_SEMANTICS.has(value.node.semantics) ||
    !(typeof value.node.sourceNode === 'string' || value.node.sourceNode === null) ||
    typeof value.node.actor !== 'string' ||
    !nonNegativeOrNull(value.node.potBb) ||
    !nonNegativeOrNull(value.node.facingBetBb) ||
    !exactObjectKeys(value.node, ['semantics', 'sourceNode', 'actor', 'potBb', 'facingBetBb'])
  ) {
    errors.push('node');
  }
  if (!Array.isArray(value.actions)) errors.push('actions');
  else {
    if (value.kind !== 'unavailable' && value.actions.length === 0) errors.push('actions.empty');
    value.actions.forEach((action, index) => validateAction(action, errors, index));
  }
  const actionIds = new Set<string>(
    (Array.isArray(value.actions) ? value.actions : []).map((entry: any) => entry?.id)
  );
  if (actionIds.size !== (Array.isArray(value.actions) ? value.actions.length : 0))
    errors.push('actions.duplicateId');
  const frequencySum = (Array.isArray(value.actions) ? value.actions : []).reduce(
    (sum: number, action: any) => sum + (Number(action?.frequency) || 0),
    0
  );
  if (value.actions?.length > 0 && Math.abs(frequencySum - 1) > 1e-6)
    errors.push('distributionSum');
  if (!object(value.distribution)) errors.push('distribution');
  else {
    for (const action of value.actions || []) {
      if (
        !Number.isFinite(value.distribution[action.id]) ||
        Math.abs(Number(value.distribution[action.id]) - Number(action.frequency)) > 1e-9
      ) {
        errors.push(`distribution.${action.id}`);
      }
    }
    if (
      Object.entries(value.distribution).some(
        ([id, frequency]) =>
          !actionIds.has(id) ||
          !Number.isFinite(frequency) ||
          Number(frequency) < 0 ||
          Number(frequency) > 1
      )
    )
      errors.push('distribution.extraAction');
  }
  if (
    !Array.isArray(value.legalSizes) ||
    value.legalSizes.some(
      (entry: any) =>
        !object(entry) ||
        !actionIds.has(entry.actionId) ||
        !SIZE_UNITS.has(entry.unit) ||
        !nonNegativeOrNull(entry.chips) ||
        !nonNegativeOrNull(entry.bigBlinds) ||
        !nonNegativeOrNull(entry.potFraction) ||
        typeof entry.exact !== 'boolean' ||
        !exactObjectKeys(entry, ['actionId', 'unit', 'chips', 'bigBlinds', 'potFraction', 'exact'])
    )
  ) {
    errors.push('legalSizes');
  } else {
    const expectedLegalSizes = (value.actions || [])
      .filter((action: any) => action.legal && action.size?.unit !== 'none')
      .map((action: any) => ({ actionId: action.id, ...action.size }));
    if (stableSolverPolicyJson(value.legalSizes) !== stableSolverPolicyJson(expectedLegalSizes)) {
      errors.push('legalSizes.mismatch');
    }
  }
  if (
    !object(value.chipEv) ||
    value.chipEv.unit !== 'big_blinds' ||
    !finiteOrNull(value.chipEv.policy) ||
    !object(value.chipEv.byAction) ||
    Object.entries(value.chipEv.byAction || {}).some(
      ([id, ev]) => !actionIds.has(id) || !finiteOrNull(ev)
    ) ||
    [...actionIds].some(
      (id) => !Object.prototype.hasOwnProperty.call(value.chipEv.byAction || {}, id)
    ) ||
    typeof value.chipEv.measuredByAction !== 'boolean' ||
    (Array.isArray(value.actions) &&
      value.actions.some(
        (action: any) =>
          value.chipEv.byAction?.[action.id] !== action.chipEvBb ||
          (value.chipEv.measuredByAction
            ? !Number.isFinite(action.chipEvBb)
            : action.chipEvBb !== null)
      )) ||
    !exactObjectKeys(value.chipEv, ['unit', 'policy', 'byAction', 'measuredByAction'])
  ) {
    errors.push('chipEv');
  }
  if (
    !object(value.tournamentUtilityEv) ||
    typeof value.tournamentUtilityEv.unit !== 'string' ||
    !finiteOrNull(value.tournamentUtilityEv.policy) ||
    !object(value.tournamentUtilityEv.byAction) ||
    Object.entries(value.tournamentUtilityEv.byAction || {}).some(
      ([id, ev]) => !actionIds.has(id) || !finiteOrNull(ev)
    ) ||
    [...actionIds].some(
      (id) => !Object.prototype.hasOwnProperty.call(value.tournamentUtilityEv.byAction || {}, id)
    ) ||
    typeof value.tournamentUtilityEv.measuredByAction !== 'boolean' ||
    (Array.isArray(value.actions) &&
      value.actions.some(
        (action: any) =>
          value.tournamentUtilityEv.byAction?.[action.id] !== action.tournamentUtilityEv ||
          (value.tournamentUtilityEv.measuredByAction
            ? !Number.isFinite(action.tournamentUtilityEv)
            : action.tournamentUtilityEv !== null)
      )) ||
    !exactObjectKeys(value.tournamentUtilityEv, ['unit', 'policy', 'byAction', 'measuredByAction'])
  ) {
    errors.push('tournamentUtilityEv');
  }
  if (
    !object(value.sourceArtifact) ||
    typeof value.sourceArtifact.system !== 'string' ||
    !nullableString(value.sourceArtifact.artifactId) ||
    !nullableString(value.sourceArtifact.scenarioHash) ||
    !nullableString(value.sourceArtifact.solverVersion) ||
    !nullableString(value.sourceArtifact.solverBinaryChecksum) ||
    !nullableString(value.sourceArtifact.machineId) ||
    !nullableString(value.sourceArtifact.pipelineCommit) ||
    !nullableString(value.sourceArtifact.manifestVersion) ||
    !nullableString(value.sourceArtifact.manifestChecksum) ||
    !nullableString(value.sourceArtifact.sourceArtifactChecksum) ||
    !nullableString(value.sourceArtifact.qualityStatus) ||
    !nullableString(value.sourceArtifact.auditedAt) ||
    typeof value.sourceArtifact.provenanceComplete !== 'boolean' ||
    !exactObjectKeys(value.sourceArtifact, [
      'system',
      'artifactId',
      'scenarioHash',
      'solverVersion',
      'solverBinaryChecksum',
      'machineId',
      'pipelineCommit',
      'manifestVersion',
      'manifestChecksum',
      'sourceArtifactChecksum',
      'qualityStatus',
      'auditedAt',
      'provenanceComplete',
    ])
  )
    errors.push('sourceArtifact');
  if (!QUALITY_SEALS.has(value.qualitySeal)) errors.push('qualitySeal');
  else if (
    !POLICY_KINDS.has(value.kind) ||
    !QUALITY_SEALS_BY_KIND[value.kind as SolverPolicyKind].has(value.qualitySeal)
  ) {
    errors.push('kindQualitySeal');
  }
  if (
    !object(value.validDomain) ||
    typeof value.validDomain.completeKey !== 'boolean' ||
    !strings(value.validDomain.missingKeyDimensions) ||
    !strings(value.validDomain.exactMatchDimensions) ||
    !strings(value.validDomain.approximatedDimensions) ||
    !strings(value.validDomain.exclusions) ||
    !exactObjectKeys(value.validDomain, [
      'completeKey',
      'missingKeyDimensions',
      'exactMatchDimensions',
      'approximatedDimensions',
      'exclusions',
    ])
  )
    errors.push('validDomain');
  else {
    const keyState = object(value.key)
      ? solverPolicyKeyMissingDimensions(value.key as SolverPolicyDecisionKey)
      : ['key'];
    if (value.validDomain.completeKey !== (keyState.length === 0))
      errors.push('validDomain.completeKey');
    if (
      stableSolverPolicyJson([...value.validDomain.missingKeyDimensions].sort()) !==
      stableSolverPolicyJson([...keyState].sort())
    )
      errors.push('validDomain.missingKeyDimensions');
  }
  if (
    !object(value.confidence) ||
    !Number.isFinite(value.confidence.score) ||
    value.confidence.score < 0 ||
    value.confidence.score > 1 ||
    !['none', 'low', 'medium', 'high'].includes(value.confidence.level) ||
    !exactObjectKeys(value.confidence, ['score', 'level'])
  )
    errors.push('confidence');
  else {
    const expectedLevel =
      value.confidence.score >= 0.9
        ? 'high'
        : value.confidence.score >= 0.6
          ? 'medium'
          : value.confidence.score > 0
            ? 'low'
            : 'none';
    if (value.confidence.level !== expectedLevel) errors.push('confidence.level');
  }
  if (!(typeof value.fallbackReason === 'string' || value.fallbackReason === null))
    errors.push('fallbackReason');
  if (!(value.rangeDistribution === null || object(value.rangeDistribution)))
    errors.push('rangeDistribution');
  if (object(value.rangeDistribution)) {
    for (const [hand, mix] of Object.entries(value.rangeDistribution)) {
      if (!object(mix)) {
        errors.push(`rangeDistribution.${hand}`);
        continue;
      }
      const entries = Object.entries(mix);
      if (
        entries.some(
          ([id, frequency]) =>
            !actionIds.has(id) ||
            !Number.isFinite(frequency) ||
            Number(frequency) < 0 ||
            Number(frequency) > 1
        )
      ) {
        errors.push(`rangeDistribution.${hand}.actions`);
      }
      const total = entries.reduce((sum, [, frequency]) => sum + Number(frequency), 0);
      if (Math.abs(total - 1) > 1e-6) errors.push(`rangeDistribution.${hand}.sum`);
    }
  }
  if (value.kind === 'exact') {
    const missing = object(value.key)
      ? solverPolicyKeyMissingDimensions(value.key as SolverPolicyDecisionKey)
      : ['key'];
    if (missing.length > 0) errors.push('exact.completeKey');
    if (value.qualitySeal !== 'SOLVER_EXACT') errors.push('exact.qualitySeal');
    if (!exactSourceComplete(value.sourceArtifact)) errors.push('exact.provenance');
    if (/v1(?!\d)/i.test(String(value.sourceArtifact?.system || ''))) errors.push('exact.legacyV1');
    if (value.validDomain?.approximatedDimensions?.length > 0) errors.push('exact.approximation');
    if (value.fallbackReason) errors.push('exact.fallback');
    const exactActions = Array.isArray(value.actions)
      ? (value.actions as SolverPolicyAction[])
      : [];
    if (!exactActions.every(exactActionSizeIsComplete)) errors.push('exact.actionSizes');
    if (
      !object(value.key) ||
      !object(value.node) ||
      !exactActions.every((action) =>
        exactActionUnitsAreConsistent(
          action,
          value.key as SolverPolicyDecisionKey,
          value.node as SolverPolicyAnswer['node']
        )
      )
    ) {
      errors.push('exact.actionUnits');
    }
    if (
      !object(value.key) ||
      !exactActions.every((action) =>
        exactActionIsLegalForKey(action, value.key as SolverPolicyDecisionKey)
      )
    ) {
      errors.push('exact.legalActions');
    }
    if (
      !object(value.node) ||
      !object(value.key) ||
      !exactNodeIsConsistent(
        value.node as SolverPolicyAnswer['node'],
        value.key as SolverPolicyDecisionKey
      )
    )
      errors.push('exact.node');
    if (!exactDomainIsConsistent(value.validDomain as SolverPolicyAnswer['validDomain']))
      errors.push('exact.domain');
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateSolverPolicyArtifactBundle(value: unknown): {
  valid: boolean;
  errors: string[];
  bundle: SolverPolicyArtifactBundle | null;
} {
  const errors: string[] = [];
  if (!object(value)) return { valid: false, errors: ['artifact'], bundle: null };
  if (
    !exactObjectKeys(value, [
      'contractVersion',
      'schemaSha256',
      'policyVersion',
      'generatedAt',
      'sourceArtifact',
      'policies',
    ])
  )
    errors.push('artifact.shape');
  if (value.contractVersion !== SOLVER_POLICY_CONTRACT_VERSION)
    errors.push('artifact.contractVersion');
  if (value.schemaSha256 !== SOLVER_POLICY_SCHEMA_SHA256) errors.push('artifact.schemaSha256');
  if (typeof value.policyVersion !== 'string' || !value.policyVersion)
    errors.push('artifact.policyVersion');
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)))
    errors.push('artifact.generatedAt');
  if (typeof value.sourceArtifact !== 'string' || !value.sourceArtifact)
    errors.push('artifact.sourceArtifact');
  if (!Array.isArray(value.policies)) errors.push('artifact.policies');
  else {
    if (value.policies.length === 0) errors.push('artifact.policies.empty');
    const scenarios = new Set<string>();
    const keys = new Set<string>();
    value.policies.forEach((policy, index) => {
      const result = validateSolverPolicyAnswer(policy);
      result.errors.forEach((error) => errors.push(`artifact.policies.${index}.${error}`));
      const scenario =
        object(policy) &&
        object(policy.sourceArtifact) &&
        typeof policy.sourceArtifact.scenarioHash === 'string'
          ? policy.sourceArtifact.scenarioHash
          : null;
      const key = object(policy) && object(policy.key) ? stableSolverPolicyJson(policy.key) : null;
      if (scenario && scenarios.has(scenario)) errors.push(`duplicate_scenario_hash:${scenario}`);
      if (key && keys.has(key)) errors.push(`duplicate_decision_key:${index}`);
      if (scenario) scenarios.add(scenario);
      if (key) keys.add(key);
    });
  }
  return {
    valid: errors.length === 0,
    errors,
    bundle: errors.length === 0 ? (value as unknown as SolverPolicyArtifactBundle) : null,
  };
}

export function deepFreezeSolverPolicy<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreezeSolverPolicy(child);
  }
  return value;
}
