/** Independent whole-tournament flag contract. Never a Phase8 promotion. */
import { createHash } from 'node:crypto';
import type { HorseDecideOpts } from '../engine/HorseLogic.js';
import type { TournamentLeagueRequest, TournamentLeagueResult } from './HorseTournamentLeague.js';
import { HUMAN_CALIBRATED_POPULATION_ID } from './HumanCalibratedPopulation.js';

export const TOURNAMENT_FLAG_VARIANTS = ['plo4', 'plo5', 'plo6'] as const;
export type TournamentFlagVariant = (typeof TOURNAMENT_FLAG_VARIANTS)[number];
export const TOURNAMENT_FLAG_HISTORICAL_SEEDS = [53101101, 53102203, 53103307] as const;
/** Reserved before any successor deal; historical seeds were exposed in unit-test source. */
export const TOURNAMENT_FLAG_HOLDOUT_SEEDS = [53901101, 53902203, 53903307] as const;
export const TOURNAMENT_FLAG_PAIRS = 1024;
export const TOURNAMENT_FLAG_SHARD_PAIRS = 64;
export const TOURNAMENT_FLAG_CARDS = Object.freeze(
  TOURNAMENT_FLAG_VARIANTS.flatMap((variant) =>
    (['mtt', 'sng'] as const).map((objective) =>
      Object.freeze({
        name: `${variant}_v53_icm_${objective}`,
        variant,
        objective,
        entrants: objective === 'mtt' ? 18 : 6,
        payouts: objective === 'mtt' ? [50, 30, 20] : [65, 35],
        a: Object.freeze({ v53PloTourneyIcm: true }) as HorseDecideOpts,
        b: Object.freeze({}) as HorseDecideOpts,
      })
    )
  )
);
export const tournamentFlagCard = (name?: string) =>
  TOURNAMENT_FLAG_CARDS.find((c) => c.name === name);
export const canonicalTournamentFlag = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonicalTournamentFlag).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalTournamentFlag(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};
export const tournamentFlagHash = (value: unknown) =>
  createHash('sha256').update(canonicalTournamentFlag(value)).digest('hex');
export const TOURNAMENT_FLAG_DESIGN = Object.freeze({
  schema: 'horse-tournament-flag-design-v1',
  cards: TOURNAMENT_FLAG_CARDS,
  historicalSeeds: TOURNAMENT_FLAG_HISTORICAL_SEEDS,
  heldoutSeeds: TOURNAMENT_FLAG_HOLDOUT_SEEDS,
  pairs: TOURNAMENT_FLAG_PAIRS,
  shardPairs: TOURNAMENT_FLAG_SHARD_PAIRS,
  field: HUMAN_CALIBRATED_POPULATION_ID,
  metric: 'realized_prize_share_candidate_minus_reference',
  intervalMultiplier: 2.59,
  pooledLowerBoundAbove: 0,
  allSeedsPointEstimateAbove: 0,
  illegalActions: 0,
  conservationErrors: 0,
  truncatedHands: 0,
  minimumChangedDecisions: 1,
  maxAttempts: 1,
  activation: false,
});
export interface TournamentFlagAdmission {
  sourceSha: string;
  planDigest: string;
  providerRunId: number;
  providerJobId: number;
  runAttempt: 1;
}
export function validateTournamentFlagRequest(request: TournamentLeagueRequest) {
  if (request.flagCard === undefined) {
    if ((TOURNAMENT_FLAG_HOLDOUT_SEEDS as readonly number[]).includes(request.seed))
      throw Error('Reserved tournament seed cannot be used by development');
    if (request.firstPair !== undefined || request.flagQualification !== undefined)
      throw Error('Flag coordinates without card');
    return undefined;
  }
  const card = tournamentFlagCard(request.flagCard);
  if (
    !card ||
    card.objective !== request.objective ||
    request.phase8PolicyFamily !== undefined ||
    request.candidateMode !== undefined ||
    request.evidenceMode === 'promotion'
  )
    throw Error('Unknown or unsupported tournament flag card domain');
  const first = request.firstPair ?? 0;
  if (
    !Number.isSafeInteger(first) ||
    first < 0 ||
    !Number.isSafeInteger(request.pairs) ||
    request.pairs < 1 ||
    first + request.pairs > TOURNAMENT_FLAG_PAIRS
  )
    throw Error('Invalid tournament flag card range');
  const heldout = (TOURNAMENT_FLAG_HOLDOUT_SEEDS as readonly number[]).includes(request.seed);
  const a = request.flagQualification;
  if (heldout) {
    if (
      !a ||
      !/^[a-f0-9]{40}$/.test(a.sourceSha) ||
      !/^[a-f0-9]{64}$/.test(a.planDigest) ||
      !Number.isSafeInteger(a.providerRunId) ||
      a.providerRunId < 1 ||
      !Number.isSafeInteger(a.providerJobId) ||
      a.providerJobId < 1 ||
      a.runAttempt !== 1 ||
      request.pairs !== TOURNAMENT_FLAG_SHARD_PAIRS ||
      first % TOURNAMENT_FLAG_SHARD_PAIRS !== 0 ||
      request.opponentPopulation !== HUMAN_CALIBRATED_POPULATION_ID
    )
      throw Error('Reserved tournament seed requires qualified provider admission');
  } else if (a) throw Error('Qualification cannot relabel a development seed');
  return card;
}
/** Additional closed card result shape, including original per-pair scientific values. */
export function tournamentFlagResultValid(r: TournamentLeagueResult): boolean {
  const keys = ['gameVariant', 'firstPair', 'cardDecisions', 'cardChanged', 'cardPairs'];
  if (r.flagCard === undefined) return keys.every((k) => !(k in r));
  const c = tournamentFlagCard(r.flagCard);
  if (
    !c ||
    c.variant !== r.gameVariant ||
    c.objective !== r.objective ||
    r.promotionEligible !== false ||
    !Number.isSafeInteger(r.firstPair) ||
    r.firstPair! < 0 ||
    r.firstPair! + r.requestedPairs > TOURNAMENT_FLAG_PAIRS ||
    !Number.isSafeInteger(r.cardDecisions) ||
    r.cardDecisions! < 0 ||
    r.cardDecisions! > r.decisions ||
    !Number.isSafeInteger(r.cardChanged) ||
    r.cardChanged! < 0 ||
    r.cardChanged! > r.cardDecisions! ||
    !Array.isArray(r.cardPairs) ||
    r.cardPairs.length !== r.pairs
  )
    return false;
  if (
    !r.cardPairs.every(
      (p, i) =>
        Object.keys(p).sort().join(',') === 'candidate,index,reference' &&
        p.index === r.firstPair! + i &&
        Number.isFinite(p.candidate) &&
        p.candidate >= 0 &&
        p.candidate <= 1 &&
        Number.isFinite(p.reference) &&
        p.reference >= 0 &&
        p.reference <= 1
    )
  )
    return false;
  const n = r.cardPairs.length;
  if (!n) return r.meanDifference === 0 && r.standardError === 0;
  const a = r.cardPairs.reduce((s, p) => s + p.candidate, 0) / n,
    b = r.cardPairs.reduce((s, p) => s + p.reference, 0) / n;
  const mean = a - b,
    se =
      n > 1
        ? Math.sqrt(
            r.cardPairs.reduce((s, p) => s + (p.candidate - p.reference - mean) ** 2, 0) /
              (n - 1) /
              n
          )
        : 0;
  return (
    Math.abs(r.candidateReturn - a) < 1e-8 &&
    Math.abs(r.baselineReturn - b) < 1e-8 &&
    Math.abs(r.meanDifference - mean) < 1e-8 &&
    Math.abs(r.standardError - se) < 1e-8
  );
}
export function tournamentFlagCells(cardName: string) {
  if (!tournamentFlagCard(cardName)) throw Error('Unknown card');
  return TOURNAMENT_FLAG_HOLDOUT_SEEDS.flatMap((seed) =>
    Array.from({ length: 16 }, (_, i) => ({
      key: `${cardName}-${seed}-${i * 64}`,
      card: cardName,
      seed,
      firstPair: i * 64,
      pairs: 64,
    }))
  );
}
