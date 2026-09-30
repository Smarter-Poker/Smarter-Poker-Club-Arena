import { createHash } from 'node:crypto';
import {
  HorseMind,
  SCOPE_MIN_HANDS,
  type HorseMindSandbox,
  type OpponentStats,
  type ReadScope,
} from './HorseMind.js';
import type { TournamentUtilityInput } from './HorseTournamentUtility.js';
import type { SeatPlayer } from '../types.js';

type Counters = Readonly<Pick<OpponentStats, 'hands' | 'vpip' | 'pfr' | 'folds' | 'facedAggr'>>;
type RecentCounters = Readonly<Pick<OpponentStats, 'rHands' | 'rFolds' | 'rFacedAggr'>>;
type Source = 'family_size' | 'pooled' | 'unavailable' | 'disabled';
export interface HorseTournamentUtilityObservations {
  scope: ReadScope | null;
  reads: Pick<HorseMindSandbox, 'stats' | 'scoped'>;
  mindEnabled: boolean;
}

/** Acquisition attribution for the bounded live joint population. Independent
 * boards share retained opponent hands and one physical deck in each sample.
 * This receipt is not a calibration claim or an acquisition ownership token. */
export interface HorseTournamentJointSamplerProvenance {
  readonly version: 'horse-joint-sampler-provenance-v1';
  readonly samplerVersion: 'joint-public-range-round1-v1';
  readonly stateKey: string;
  readonly layout: 'independent';
  readonly sharedPrefixLength: 0;
  readonly boardCount: 1 | 2 | 3;
  readonly requestedSamples: number;
  readonly completedSamples: number;
  readonly sampleBudgetExhausted: boolean;
  /** Includes attempted range draws in a discarded partial final sample. */
  readonly uniformEscapes: number;
  readonly physicalCardsPerSample: number;
  readonly unknownDealtCardsPerSample: number;
  readonly rangeModel: Readonly<{
    version: 'joint-public-range-round1-v1';
    source: 'explicit_public_line_heuristic';
    confidence: 'heuristic_uncalibrated';
  }>;
}

/** Decision-local statistics only. The complete replay frame includes plans
 * and cannot be exported while an intent capture is open. Copy the existing
 * read getters without touching plans, dirty flags or observation ownership. */
export function captureHorseTournamentUtilityObservations(
  opponents: readonly SeatPlayer[],
  mindEnabled: boolean
): HorseTournamentUtilityObservations {
  const scope = HorseMind.currentScope();
  const stats = new Map<string, OpponentStats>();
  const scoped = new Map<string, OpponentStats>();
  if (opponents.length > 9) throw Error('Horse utility observation actor limit');
  if (mindEnabled) {
    for (const opponent of opponents) {
      const pooled = HorseMind.getStats(opponent.user_id);
      if (pooled) stats.set(opponent.user_id, { ...pooled });
      const row = scope ? HorseMind.getScopedStats(opponent.user_id, scope) : undefined;
      if (row) scoped.set(`${scope}|${opponent.user_id}`, { ...row });
    }
  }
  return { scope, reads: { stats, scoped }, mindEnabled };
}

/** Private input attribution, not calibrated opponent-response or GTO proof.
 * Read-frame ownership and actual execution are bound by their existing owners. */
export interface HorseTournamentUtilityEvidence {
  readonly version: 'horse-tournament-utility-evidence-v1';
  readonly inputSha256: string;
  /** Present only for an actual bounded joint acquisition, never zipped marginals. */
  readonly sampler?: HorseTournamentJointSamplerProvenance;
  readonly responseModel: Readonly<{
    id: 'mdf-strength-v1';
    calibration: 'uncalibrated';
    modelErrorBound: null;
  }>;
  readonly confidence: Readonly<{
    basis: 'conditional_sampling_equity_icm';
    responseModelErrorIncluded: false;
  }>;
  readonly observations: Readonly<{
    status: 'captured' | 'unavailable' | 'disabled';
    scope: ReadScope | null;
    window: Readonly<{ status: 'not_recorded'; from: null; to: null }>;
    tableIsolation: 'not_established';
    formatIsolation: 'not_established';
    exactVariantIsolation: 'not_established';
  }>;
  readonly opponents: ReadonlyArray<
    Readonly<{
      userId: string;
      range: readonly [number, number] | null;
      foldMul: number;
      actsAfterHero: boolean;
      statistics: Readonly<{ source: Source; scope: ReadScope | null; counters: Counters | null }>;
      recency: Readonly<{
        source: Exclude<Source, 'family_size'> | 'family_size_fallback';
        counters: RecentCounters | null;
      }>;
    }>
  >;
}

const VERSION = 'horse-tournament-utility-evidence-v1';
const COUNTERS = ['hands', 'vpip', 'pfr', 'folds', 'facedAggr'] as const;
const RECENT = ['rHands', 'rFolds', 'rFacedAggr'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const scopeValid = (value: unknown): value is ReadScope | null =>
  value === null ||
  (typeof value === 'string' && /^(holdem|omaha|sixplus):(hu|short|full)$/.test(value));
const actor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const fail = (): never => {
  throw Error('Horse tournament utility evidence is invalid');
};

/** Receipt shape only. The acquisition owner separately checks the exact
 * state key, variant deck size and module-private sample ownership. */
export function horseTournamentJointSamplerProvenanceIsValid(
  value: unknown
): value is HorseTournamentJointSamplerProvenance {
  const whole = (n: unknown, min: number, max: number): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
  return (
    exact(value, [
      'version',
      'samplerVersion',
      'stateKey',
      'layout',
      'sharedPrefixLength',
      'boardCount',
      'requestedSamples',
      'completedSamples',
      'sampleBudgetExhausted',
      'uniformEscapes',
      'physicalCardsPerSample',
      'unknownDealtCardsPerSample',
      'rangeModel',
    ]) &&
    value.version === 'horse-joint-sampler-provenance-v1' &&
    value.samplerVersion === 'joint-public-range-round1-v1' &&
    typeof value.stateKey === 'string' &&
    /^phase5-v1:[a-f0-9]{64}$/.test(value.stateKey) &&
    value.layout === 'independent' &&
    value.sharedPrefixLength === 0 &&
    whole(value.boardCount, 1, 3) &&
    whole(value.requestedSamples, 8, 16) &&
    whole(value.completedSamples, 8, value.requestedSamples) &&
    value.sampleBudgetExhausted === value.completedSamples < value.requestedSamples &&
    whole(value.uniformEscapes, 0, value.requestedSamples * 9) &&
    whole(value.physicalCardsPerSample, 9, 52) &&
    whole(value.unknownDealtCardsPerSample, 2, 52) &&
    // Complete independent boards, at least two hero cards and every retained
    // unknown dealt card must fit. Folded cards remain physically reserved.
    value.boardCount * 5 + 2 + value.unknownDealtCardsPerSample <= value.physicalCardsPerSample &&
    exact(value.rangeModel, ['version', 'source', 'confidence']) &&
    value.rangeModel.version === value.samplerVersion &&
    value.rangeModel.source === 'explicit_public_line_heuristic' &&
    value.rangeModel.confidence === 'heuristic_uncalibrated'
  );
}

/** Explicit inputs, including the actual joint samples, are hashed privately.
 * Wall-clock callbacks, accounting of work performed, previous receipts and
 * think time cannot relabel the sampled economic model. Object key order is
 * irrelevant; array order remains material (sample indices own response draws). */
export function horseTournamentUtilityInputSha256(input: TournamentUtilityInput): string {
  const seat = (p: SeatPlayer) => ({
    userId: p.user_id,
    seat: p.seat,
    stack: p.stack,
    bet: p.bet,
    totalInvested: p.totalInvested,
    deadInvested: p.deadInvested ?? 0,
    individualAnteInvested: p.individualAnteInvested ?? 0,
    returnedUncalled: p.returnedUncalled ?? 0,
    folded: p.is_folded,
    allIn: p.is_all_in,
    sittingOut: p.is_sitting_out,
  });
  const material = {
    version: VERSION,
    settlement: input.settlement ?? null,
    continuation: input.continuation
      ? {
          dealerSeat: input.continuation.dealerSeat,
          bigBlind: input.continuation.bigBlind,
          shortStackThresholdChips: input.continuation.shortStackThresholdChips ?? null,
          futureHands: input.continuation.futureHands ?? null,
        }
      : null,
    street: input.street,
    hero: seat(input.hero),
    players: input.players.map(seat),
    pots: input.pots,
    pot: input.pot,
    currentBet: input.currentBet,
    toCall: input.toCall,
    legalActions: input.legalActions,
    minRaiseTo: input.minRaiseTo,
    maxRaiseTo: input.maxRaiseTo,
    bettingStructure: input.bettingStructure,
    baseline: { action: input.baseline.action, amount: input.baseline.amount ?? null },
    heroEquity: input.heroEquity,
    equitySampleSize: input.equitySampleSize,
    equityStandardError: input.equityStandardError,
    opponents: input.opponents,
    sampledOpponentIds: input.sampledOpponentIds,
    showdownSamples: input.showdownSamples,
    context: input.context,
    // Do not add even a null field to the predecessor's input commitment.
    ...(input.samplerProvenance === undefined
      ? {}
      : { samplerProvenance: input.samplerProvenance }),
  };
  return utilityMaterialSha256(material);
}

/** Journal serialization sorts object keys. The same commitment must survive
 * that canonical representation as well as a structured clone. */
export function horseTournamentUtilityEvidenceSha256(
  evidence: HorseTournamentUtilityEvidence
): string {
  return utilityMaterialSha256(evidence);
}

function utilityMaterialSha256(material: unknown): string {
  // Refuse malformed/unbounded evidence rather than silently dropping a field,
  // serializing nonfinite numbers as null, or exporting the sample population.
  let nodes = 0;
  const canonical = (value: unknown, depth: number): unknown => {
    if (++nodes > 150_000 || depth > 24) return fail();
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fail();
    if (Array.isArray(value)) return value.map((entry) => canonical(entry, depth + 1));
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return fail();
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key], depth + 1)])
    );
  };
  const json = JSON.stringify(canonical(material, 0));
  if (Buffer.byteLength(json) > 2 * 1024 * 1024) return fail();
  return createHash('sha256').update(json).digest('hex');
}

export function buildHorseTournamentUtilityEvidence(
  input: TournamentUtilityInput,
  observations?: HorseTournamentUtilityObservations
): HorseTournamentUtilityEvidence {
  if (
    observations &&
    (!scopeValid(observations.scope) || typeof observations.mindEnabled !== 'boolean')
  )
    return fail();
  const sampler = input.samplerProvenance;
  if (
    sampler !== undefined &&
    (!horseTournamentJointSamplerProvenanceIsValid(sampler) ||
      sampler.completedSamples !== input.showdownSamples.length ||
      sampler.completedSamples !== input.equitySampleSize ||
      input.showdownSamples.some((sample) => sample.boards.length !== sampler.boardCount))
  )
    return fail();
  const status = observations
    ? observations.mindEnabled
      ? 'captured'
      : 'disabled'
    : 'unavailable';
  const scope = observations?.scope ?? null;
  const evidence: HorseTournamentUtilityEvidence = {
    version: VERSION,
    inputSha256: horseTournamentUtilityInputSha256(input),
    ...(sampler === undefined
      ? {}
      : {
          sampler: Object.freeze({
            ...sampler,
            rangeModel: Object.freeze({ ...sampler.rangeModel }),
          }),
        }),
    responseModel: Object.freeze({
      id: 'mdf-strength-v1',
      calibration: 'uncalibrated',
      modelErrorBound: null,
    }),
    confidence: Object.freeze({
      basis: 'conditional_sampling_equity_icm',
      responseModelErrorIncluded: false,
    }),
    observations: Object.freeze({
      status,
      scope,
      window: Object.freeze({ status: 'not_recorded', from: null, to: null }),
      tableIsolation: 'not_established',
      formatIsolation: 'not_established',
      exactVariantIsolation: 'not_established',
    }),
    opponents: Object.freeze(
      input.opponents.map((opponent) => {
        const pooled =
          status === 'captured' ? observations!.reads.stats.get(opponent.userId) : undefined;
        const scoped =
          status === 'captured' && scope
            ? observations!.reads.scoped.get(`${scope}|${opponent.userId}`)
            : undefined;
        // This is HorseMind.readStats' actual selection, not the table/format
        // from the current request pretending to be a historical observation.
        const scopedSelected = scoped !== undefined && scoped.hands >= SCOPE_MIN_HANDS;
        const selected = scopedSelected ? scoped : pooled;
        const source: Source =
          status === 'disabled'
            ? 'disabled'
            : selected
              ? scopedSelected
                ? 'family_size'
                : 'pooled'
              : 'unavailable';
        const copy = <K extends keyof OpponentStats>(row: OpponentStats, keys: readonly K[]) =>
          Object.freeze(Object.fromEntries(keys.map((key) => [key, row[key]]))) as Readonly<
            Pick<OpponentStats, K>
          >;
        return Object.freeze({
          userId: opponent.userId,
          range:
            opponent.range === null ? null : Object.freeze([...opponent.range] as [number, number]),
          foldMul: opponent.foldMul,
          actsAfterHero: opponent.actsAfterHero,
          statistics: Object.freeze({
            source,
            scope: source === 'family_size' ? scope : null,
            counters: selected ? copy(selected, COUNTERS) : null,
          }),
          // exploit() blends the pooled recency bucket even when lifetime reads
          // use family/size. A scoped row alone is its literal fallback.
          recency: Object.freeze({
            source:
              status === 'disabled'
                ? 'disabled'
                : pooled
                  ? 'pooled'
                  : selected
                    ? 'family_size_fallback'
                    : 'unavailable',
            counters: pooled || selected ? copy((pooled ?? selected)!, RECENT) : null,
          }),
        });
      })
    ),
  };
  if (!horseTournamentUtilityEvidenceIsValid(evidence, input.sampledOpponentIds)) return fail();
  return Object.freeze(evidence);
}

/** Structured-clone boundary validator, not an independent calibration check. */
export function horseTournamentUtilityEvidenceIsValid(
  value: unknown,
  opponentIds?: readonly string[]
): value is HorseTournamentUtilityEvidence {
  if (
    !exact(value, [
      'version',
      'inputSha256',
      'responseModel',
      'confidence',
      'observations',
      'opponents',
      ...(object(value) && Object.hasOwn(value, 'sampler') ? ['sampler'] : []),
    ]) ||
    (Object.hasOwn(value, 'sampler') &&
      !horseTournamentJointSamplerProvenanceIsValid(value.sampler)) ||
    value.version !== VERSION ||
    typeof value.inputSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.inputSha256) ||
    !exact(value.responseModel, ['id', 'calibration', 'modelErrorBound']) ||
    value.responseModel.id !== 'mdf-strength-v1' ||
    value.responseModel.calibration !== 'uncalibrated' ||
    value.responseModel.modelErrorBound !== null ||
    !exact(value.confidence, ['basis', 'responseModelErrorIncluded']) ||
    value.confidence.basis !== 'conditional_sampling_equity_icm' ||
    value.confidence.responseModelErrorIncluded !== false ||
    !exact(value.observations, [
      'status',
      'scope',
      'window',
      'tableIsolation',
      'formatIsolation',
      'exactVariantIsolation',
    ]) ||
    !['captured', 'unavailable', 'disabled'].includes(value.observations.status as string) ||
    !scopeValid(value.observations.scope) ||
    !exact(value.observations.window, ['status', 'from', 'to']) ||
    value.observations.window.status !== 'not_recorded' ||
    value.observations.window.from !== null ||
    value.observations.window.to !== null ||
    value.observations.tableIsolation !== 'not_established' ||
    value.observations.formatIsolation !== 'not_established' ||
    value.observations.exactVariantIsolation !== 'not_established' ||
    !Array.isArray(value.opponents) ||
    value.opponents.length > 9 ||
    (value.observations.status === 'unavailable' && value.observations.scope !== null)
  )
    return false;
  const ids = new Set<string>();
  for (const row of value.opponents) {
    if (
      !exact(row, ['userId', 'range', 'foldMul', 'actsAfterHero', 'statistics', 'recency']) ||
      !actor(row.userId) ||
      ids.has(row.userId) ||
      !finite(row.foldMul) ||
      typeof row.actsAfterHero !== 'boolean' ||
      (row.range !== null &&
        (!Array.isArray(row.range) ||
          row.range.length !== 2 ||
          !finite(row.range[0]) ||
          !finite(row.range[1]) ||
          row.range[0] > row.range[1] ||
          row.range[1] > 1)) ||
      !exact(row.statistics, ['source', 'scope', 'counters']) ||
      !['family_size', 'pooled', 'unavailable', 'disabled'].includes(
        row.statistics.source as string
      ) ||
      !scopeValid(row.statistics.scope) ||
      !exact(row.recency, ['source', 'counters']) ||
      !['pooled', 'family_size_fallback', 'unavailable', 'disabled'].includes(
        row.recency.source as string
      )
    )
      return false;
    ids.add(row.userId);
    const stats = row.statistics;
    const recent = row.recency;
    if (stats.source === 'family_size' || stats.source === 'pooled') {
      const counters = stats.counters;
      if (
        value.observations.status !== 'captured' ||
        !exact(counters, COUNTERS) ||
        !COUNTERS.every((key) => finite(counters[key])) ||
        !['pooled', 'family_size_fallback'].includes(recent.source as string)
      )
        return false;
      if (
        stats.source === 'family_size'
          ? stats.scope === null ||
            stats.scope !== value.observations.scope ||
            (counters.hands as number) < SCOPE_MIN_HANDS
          : stats.scope !== null
      )
        return false;
      if (recent.source === 'family_size_fallback' && stats.source !== 'family_size') return false;
    } else if (
      stats.counters !== null ||
      stats.scope !== null ||
      recent.source !== stats.source ||
      (stats.source === 'disabled') !== (value.observations.status === 'disabled')
    )
      return false;
    const recentCounters = recent.counters;
    if (recent.source === 'pooled' || recent.source === 'family_size_fallback') {
      if (!exact(recentCounters, RECENT) || !RECENT.every((key) => finite(recentCounters[key])))
        return false;
    } else if (recentCounters !== null) return false;
  }
  return (
    opponentIds === undefined ||
    (opponentIds.length === ids.size &&
      new Set(opponentIds).size === ids.size &&
      opponentIds.every((id) => ids.has(id)))
  );
}
