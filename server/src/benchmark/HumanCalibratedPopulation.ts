/**
 * The human-calibrated opponent population (WIN-POP, 2026-10-08).
 *
 * Every strength league before this one seats the production horse population
 * (HorseLogic.decide with the five production styles) around the hero. Results
 * against that population say whether a pack beats the brain horses use today,
 * not whether it beats the players horses actually win money from. This module
 * is a separate, separately named population whose seats play the frequencies
 * production human players were measured to play
 * (docs/horse-brain-human-population-2026-10-08.md), so a league can price a
 * pack after rake against human tendencies instead of against other horses.
 *
 * Nothing here changes an existing profile, population, seed or record. A league
 * profile uses this population only when it says so with `opponentPopulation`
 * (Plo4PolicyLeague.ts), which no existing profile does.
 *
 * The model, stated so it cannot be read as more than it is:
 *  - Every target below is an aggregate frequency read from production
 *    (read-only) for human players (profiles.is_horse = false), with its count.
 *    No player identifier is recorded.
 *  - A seat ranks its own holding as a strength percentile in [0, 1): preflop
 *    by the engine's own preflop strength scales placed on the hold'em score
 *    distribution (Omaha by omahaPreflopPercentile); postflop by Monte Carlo
 *    equity against one random holding (simulateEquity, on the league's seeded
 *    fastRandom, so a deal replays exactly). It then plays the measured
 *    frequencies as thresholds: fold the weakest share, raise the strongest
 *    share, call between; bet when checked to with the strongest share.
 *  - Sizes are the measured medians. Clock timeouts are measured (11.5% of
 *    human decisions) and EXCLUDED: a seat that times out gives chips away,
 *    and a qualification must not be earned from opponents who are not there.
 *  - The calibration sample is small. `humanCalibrationAdequacy` says so, and
 *    docs/horse-brain-winning-contract-2026-10-08.md makes an adequate
 *    calibration a precondition of any qualifying claim.
 */
import type { Card, HandStage } from '../types.js';
import { RANKS, SUITS } from '../engine/PokerEngine.js';
import {
  holdemPreflopScore,
  omahaPreflopPercentile,
  pineapplePreflopStrength,
  shortDeckPreflopStrength,
  simulateEquity,
  variantInfo,
} from '../engine/HorseEval.js';

export const HUMAN_CALIBRATED_POPULATION_ID = 'human-calibrated-v1-20261008';

/** Where the targets came from. Aggregate counts only. */
export const HUMAN_CALIBRATION_SOURCE = Object.freeze({
  record: 'docs/horse-brain-human-population-2026-10-08.md',
  declaration: 'window-declaration.md (WIN-POP evidence folder, written 2026-10-08T13:56Z)',
  humanDefinition: 'profiles.is_horse = false; every such account, no exclusion',
  seatHandWindow: '2026-08-21T00:00Z to 2026-10-08T00:00Z (ca_hand_facts human rows)',
  actionWindow: 'every retained has_human hand_history row created before 2026-10-08T00:00Z',
  humanSeatHands: 2411,
  distinctHumans: 5,
  /** Share of all human seat-hands played by the single most active human. */
  topHumanShare: 0.685,
  humanDecisions: 4498,
  /** Clock-forced folds among human decisions; excluded from every profile. */
  measuredTimeoutShare: 0.115,
});

/** A three-way response: shares of fold, call and raise; they sum to 1. */
export interface ResponseShares {
  fold: number;
  call: number;
  raise: number;
  /** Decisions measured. */
  n: number;
}

export type PostflopStreet = 'flop' | 'turn' | 'river';
export type HumanCalibratedFamily = 'nlh' | 'omaha' | 'other';

/** Decision nodes whose cutoffs are fitted on reached states. */
export const HUMAN_CALIBRATED_FITTED_NODES = Object.freeze([
  'preflop/unopened',
  'preflop/facing_raise',
  'flop/facing_bet',
  'turn/facing_bet',
  'river/facing_bet',
  'flop/checked_to',
  'turn/checked_to',
  'river/checked_to',
] as const);
export type HumanCalibratedFittedNode = (typeof HUMAN_CALIBRATED_FITTED_NODES)[number];

/**
 * Strength cutoffs at one node, fitted so the seats that actually reach the
 * node play its measured shares (a seat facing a bet on the turn has already
 * survived earlier streets, so its strength is not uniform). `fold`: fold
 * below; `raise`: raise at or above (facing nodes); `bet`: bet at or above
 * (checked-to nodes).
 */
export interface HumanCalibratedCutoffs {
  fold?: number;
  raise?: number;
  bet?: number;
}

export interface HumanCalibratedProfile {
  id: string;
  family: HumanCalibratedFamily;
  /** Human seat-hands behind this family's targets. */
  seatHands: number;
  preflop: {
    /** Unopened (or limped) pot with chips to call: fold, limp, open-raise. */
    unopened: ResponseShares;
    /** Nothing to call (the big blind's option): share of raises; the rest check. */
    freeRaise: number;
    /** Facing a voluntary raise this street. */
    facingRaise: ResponseShares;
  };
  postflop: Record<
    PostflopStreet,
    { facingBet: ResponseShares; checkedToBet: number; checkedToN: number }
  >;
  /** Fitted reached-state cutoffs; a node without one plays raw shares. */
  cutoffs?: Partial<Record<HumanCalibratedFittedNode, Readonly<HumanCalibratedCutoffs>>>;
}

/** Sizes, pooled across families (bets and raises with a recorded public
 * node: preflop raises 46, flop bets 19, turn bets 18, river bets 12, postflop
 * raises 8). */
export const HUMAN_CALIBRATED_SIZING = Object.freeze({
  /** Preflop raise-to as a multiple of the current bet (median 3.75). */
  preflopRaiseToMultiple: 3.75,
  /** Postflop bet as a fraction of the pot (medians). */
  betPotFraction: Object.freeze({ flop: 0.756, turn: 0.519, river: 0.507 }),
  /** Postflop raise-to as a multiple of the current bet (medians). */
  raiseToMultiple: Object.freeze({ flop: 1.89, turn: 3.5, river: 3.5 }),
});

function shares(fold: number, call: number, raise: number): ResponseShares {
  const n = fold + call + raise;
  return Object.freeze({ fold: fold / n, call: call / n, raise: raise / n, n });
}

/**
 * Counts, not rounded shares, so the arithmetic is auditable against the
 * record. Unopened counts exclude the big blind's free checks; the free raise
 * share is the family's raises among all unopened decisions.
 */
export const HUMAN_CALIBRATED_PROFILES: readonly Readonly<HumanCalibratedProfile>[] = Object.freeze(
  [
    Object.freeze({
      id: 'human-cal-v1-nlh',
      family: 'nlh' as const,
      seatHands: 1718,
      preflop: Object.freeze({
        unopened: shares(512, 163, 160),
        freeRaise: 160 / 905,
        facingRaise: shares(347, 235, 77),
      }),
      postflop: Object.freeze({
        flop: { facingBet: shares(83, 80, 22), checkedToBet: 75 / 289, checkedToN: 289 },
        turn: { facingBet: shares(46, 67, 6), checkedToBet: 71 / 204, checkedToN: 204 },
        river: { facingBet: shares(43, 45, 7), checkedToBet: 43 / 156, checkedToN: 156 },
      }),
      /** Fitted on the p13c-nlh-6max-100bb table, 2000 deals per pass, 6 passes, seeds 14100000 + i * 100000 + k; checked on 18900000 + k (docs/horse-brain-human-population-2026-10-08.md). */
      cutoffs: Object.freeze({
        'preflop/unopened': { fold: 0.614133, raise: 0.807612 },
        'preflop/facing_raise': { fold: 0.645999, raise: 0.915058 },
        'flop/facing_bet': { fold: 0.527806, raise: 0.836321 },
        'turn/facing_bet': { fold: 0.51955, raise: 0.918558 },
        'river/facing_bet': { fold: 0.59093, raise: 0.960979 },
        'flop/checked_to': { bet: 0.716483 },
        'turn/checked_to': { bet: 0.661905 },
        'river/checked_to': { bet: 0.781622 },
      }),
    }),
    Object.freeze({
      id: 'human-cal-v1-omaha',
      family: 'omaha' as const,
      seatHands: 608,
      preflop: Object.freeze({
        unopened: shares(262, 39, 122),
        freeRaise: 122 / 494,
        facingRaise: shares(58, 35, 40),
      }),
      postflop: Object.freeze({
        flop: { facingBet: shares(29, 18, 11), checkedToBet: 61 / 147, checkedToN: 147 },
        turn: { facingBet: shares(22, 14, 8), checkedToBet: 41 / 109, checkedToN: 109 },
        river: { facingBet: shares(9, 6, 6), checkedToBet: 28 / 76, checkedToN: 76 },
      }),
      /** Fitted on the p10c-6max-100bb table, 3000 deals per pass, 12 passes, damping 0.5, seeds 14100000 + i * 100000 + k; checked on 18900000 + k (docs/horse-brain-human-population-2026-10-08.md). */
      cutoffs: Object.freeze({
        'preflop/unopened': { fold: 0.628469, raise: 0.721282 },
        'preflop/facing_raise': { fold: 0.626802, raise: 0.825469 },
        'flop/facing_bet': { fold: 0.521902, raise: 0.711989 },
        'turn/facing_bet': { fold: 0.550429, raise: 0.775068 },
        'river/facing_bet': { fold: 0.515111, raise: 0.739639 },
        'flop/checked_to': { bet: 0.583551 },
        'turn/checked_to': { bet: 0.608827 },
        'river/checked_to': { bet: 0.6185 },
      }),
    }),
    Object.freeze({
      id: 'human-cal-v1-other',
      family: 'other' as const,
      seatHands: 85,
      preflop: Object.freeze({
        unopened: shares(15, 23, 1),
        freeRaise: 1 / 42,
        facingRaise: shares(20, 46, 1),
      }),
      postflop: Object.freeze({
        flop: { facingBet: shares(1, 13, 0), checkedToBet: 16 / 46, checkedToN: 46 },
        turn: { facingBet: shares(5, 12, 1), checkedToBet: 19 / 42, checkedToN: 42 },
        river: { facingBet: shares(8, 10, 0), checkedToBet: 19 / 35, checkedToN: 35 },
      }),
      /** Fitted on the p12c-short_deck-6max-100bb table, 2000 deals per pass, 6 passes, seeds 14100000 + i * 100000 + k; checked on 18900000 + k (docs/horse-brain-human-population-2026-10-08.md). */
      cutoffs: Object.freeze({
        'preflop/unopened': { fold: 0.371196, raise: 0.971346 },
        'preflop/facing_raise': { fold: 0.411263, raise: 0.978134 },
        'flop/facing_bet': { fold: 0.283242, raise: 1 },
        'turn/facing_bet': { fold: 0.36312, raise: 0.871704 },
        'river/facing_bet': { fold: 0.460415, raise: 1 },
        'flop/checked_to': { bet: 0.588332 },
        'turn/checked_to': { bet: 0.551779 },
        'river/checked_to': { bet: 0.556823 },
      }),
    }),
  ]
);

/** The family a game variant's human targets come from. */
export function humanCalibratedFamily(variant: string): HumanCalibratedFamily {
  const v = (variant || 'nlh').toLowerCase();
  if (v === 'nlh') return 'nlh';
  if (v.startsWith('plo')) return 'omaha';
  return 'other';
}

export function humanCalibratedProfileFor(variant: string): Readonly<HumanCalibratedProfile> {
  const family = humanCalibratedFamily(variant);
  const p = HUMAN_CALIBRATED_PROFILES.find((x) => x.family === family);
  if (!p) throw new Error(`No human-calibrated profile for ${variant}`);
  return p;
}

/**
 * The minimum calibration a qualifying claim needs (the winning contract,
 * docs/horse-brain-winning-contract-2026-10-08.md). Fixed before any run.
 */
export const HUMAN_CALIBRATION_MINIMUMS = Object.freeze({
  seatHandsPerFamily: 10_000,
  distinctHumans: 20,
  maxTopHumanShare: 0.25,
});

export interface HumanCalibrationAdequacy {
  family: HumanCalibratedFamily;
  adequate: boolean;
  reasons: string[];
}

export function humanCalibrationAdequacy(
  profile: Readonly<HumanCalibratedProfile>,
  source: { distinctHumans: number; topHumanShare: number } = HUMAN_CALIBRATION_SOURCE
): HumanCalibrationAdequacy {
  const m = HUMAN_CALIBRATION_MINIMUMS;
  const reasons: string[] = [];
  if (profile.seatHands < m.seatHandsPerFamily)
    reasons.push(`seat_hands_${profile.seatHands}_below_${m.seatHandsPerFamily}`);
  if (source.distinctHumans < m.distinctHumans)
    reasons.push(`distinct_humans_${source.distinctHumans}_below_${m.distinctHumans}`);
  if (source.topHumanShare > m.maxTopHumanShare)
    reasons.push(`top_human_share_${source.topHumanShare}_above_${m.maxTopHumanShare}`);
  return { family: profile.family, adequate: reasons.length === 0, reasons };
}

let holdemScores: Float64Array | null = null;
function holdemScoreDistribution(): Float64Array {
  if (holdemScores) return holdemScores;
  const deck: Card[] = RANKS.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));
  const out: number[] = [];
  for (let i = 0; i < deck.length; i++)
    for (let j = i + 1; j < deck.length; j++) out.push(holdemPreflopScore(deck[i], deck[j], false));
  out.sort((a, b) => a - b);
  holdemScores = new Float64Array(out);
  return holdemScores;
}

/** Mid-rank percentile of `v` in the sorted hold'em score distribution. */
function holdemPercentile(v: number): number {
  const d = holdemScoreDistribution();
  let lo = 0,
    hi = d.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  const below = lo;
  let lo2 = below,
    hi2 = d.length;
  while (lo2 < hi2) {
    const mid = (lo2 + hi2) >> 1;
    if (d[mid] <= v) lo2 = mid + 1;
    else hi2 = mid;
  }
  return Math.min(0.999999, (below + (lo2 - below) / 2) / d.length);
}

/** Preflop strength percentile of a holding in its own variant. The engine's
 * short deck and Pineapple scales are already placed on the hold'em score at
 * the same percentile (HorseEval), so one hold'em distribution ranks them. */
export function humanCalibratedPreflopPercentile(cards: Card[], variant: string): number {
  const vi = variantInfo(variant);
  if (vi.isOmaha) return Math.min(0.999999, omahaPreflopPercentile(cards, vi.isHiLo));
  if (cards.length === 3) return holdemPercentile(pineapplePreflopStrength(cards, vi.isShortDeck));
  if (cards.length !== 2) throw new Error('Unsupported holding size');
  return holdemPercentile(
    vi.isShortDeck
      ? shortDeckPreflopStrength(cards[0], cards[1])
      : holdemPreflopScore(cards[0], cards[1], false)
  );
}

/**
 * Seeds. Fitting pass i deals FIT_SEED_BASE + i * 100000 + k and the fresh
 * check pass CHECK_SEED_BASE + k (k < 100000), so the ranges never meet. The
 * held-out seeds of the winning contract's condition (b) lie outside both, and
 * no test, fit or development run may deal them.
 */
export const HUMAN_CALIBRATED_FIT_SEED_BASE = 14_100_000;
export const HUMAN_CALIBRATED_MAX_FIT_ITERATIONS = 20;
export const HUMAN_CALIBRATED_CHECK_SEED_BASE = 18_900_000;
export const HUMAN_CALIBRATED_HOLDOUT_SEEDS = Object.freeze([19_201_101, 19_202_203, 19_203_307]);
export function isHumanCalibratedHoldoutSeed(seed: number): boolean {
  return HUMAN_CALIBRATED_HOLDOUT_SEEDS.includes(seed);
}

/** Postflop equity samples per decision; fixed so a deal replays exactly. */
export const HUMAN_CALIBRATED_POSTFLOP_ITERATIONS = 160;

export interface HumanCalibratedSpot {
  variant: string;
  stage: HandStage;
  cards: Card[];
  board: Card[];
  pot: number;
  toCall: number;
  currentBet: number;
  /** A voluntary bet or raise was made on this street before this seat acts. */
  aggressionThisStreet: boolean;
  legalActions: readonly string[];
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
  /** Tournament and Diamond chips are whole. */
  wholeChips: boolean;
}

export interface HumanCalibratedDecision {
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in';
  amount?: number;
  strength: number;
  node: string;
}

/** The thresholded response for a strength percentile s in [0, 1). */
export function thresholdResponse(s: number, r: ResponseShares): 'fold' | 'call' | 'raise' {
  if (s < r.fold) return 'fold';
  if (s >= 1 - r.raise) return 'raise';
  return 'call';
}

function respond(
  s: number,
  r: ResponseShares,
  c: Readonly<HumanCalibratedCutoffs> | undefined
): 'fold' | 'call' | 'raise' {
  if (!c) return thresholdResponse(s, r);
  if (s < (c.fold ?? r.fold)) return 'fold';
  if (s >= (c.raise ?? 1 - r.raise)) return 'raise';
  return 'call';
}

/** Strength histogram bins per node in a league receipt. */
export const HUMAN_CALIBRATED_STRENGTH_BINS = 50;

/** The strength at or below which `share` of the histogram's mass lies,
 * linear within a bin. */
export function histogramQuantile(bins: readonly number[], share: number): number {
  const total = bins.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('Empty histogram');
  const want = Math.min(1, Math.max(0, share)) * total;
  let run = 0;
  for (let i = 0; i < bins.length; i++) {
    if (run + bins[i] >= want && bins[i] > 0) {
      const within = (want - run) / bins[i];
      return Math.round(((i + within) / bins.length) * 1e6) / 1e6;
    }
    run += bins[i];
  }
  return 1;
}

/**
 * Cutoffs that make the strengths observed at each node play the node's
 * measured shares: fold below the fold-share quantile, raise (or bet) at or
 * above the (1 - raise-share) quantile. Nodes with fewer than `minSamples`
 * observations keep the cutoffs they had.
 */
export function fitHumanCalibratedCutoffs(
  profile: Readonly<HumanCalibratedProfile>,
  strengths: Readonly<Record<string, readonly number[]>>,
  minSamples = 200
): Partial<Record<HumanCalibratedFittedNode, HumanCalibratedCutoffs>> {
  const out: Partial<Record<HumanCalibratedFittedNode, HumanCalibratedCutoffs>> = {
    ...(profile.cutoffs ?? {}),
  };
  for (const node of HUMAN_CALIBRATED_FITTED_NODES) {
    const bins = strengths[node];
    if (!bins || bins.reduce((a, b) => a + b, 0) < minSamples) continue;
    const [street, kind] = node.split('/') as [string, string];
    if (kind === 'checked_to') {
      const share = profile.postflop[street as PostflopStreet].checkedToBet;
      out[node] = { bet: histogramQuantile(bins, 1 - share) };
      continue;
    }
    const r =
      node === 'preflop/unopened'
        ? profile.preflop.unopened
        : node === 'preflop/facing_raise'
          ? profile.preflop.facingRaise
          : profile.postflop[street as PostflopStreet].facingBet;
    out[node] = {
      fold: histogramQuantile(bins, r.fold),
      raise: histogramQuantile(bins, 1 - r.raise),
    };
  }
  return out;
}

/**
 * Damped refit: keep `weightOld` of each previous cutoff (a node without a
 * previous cutoff takes the new one). Damping lets the fit settle where a
 * cutoff and the states that reach it push each other back and forth.
 */
export function blendHumanCalibratedCutoffs(
  previous:
    | Partial<Record<HumanCalibratedFittedNode, Readonly<HumanCalibratedCutoffs>>>
    | undefined,
  next: Partial<Record<HumanCalibratedFittedNode, HumanCalibratedCutoffs>>,
  weightOld: number
): Partial<Record<HumanCalibratedFittedNode, HumanCalibratedCutoffs>> {
  if (!(weightOld >= 0 && weightOld < 1)) throw new Error('weightOld in [0, 1)');
  const out: Partial<Record<HumanCalibratedFittedNode, HumanCalibratedCutoffs>> = {};
  for (const node of HUMAN_CALIBRATED_FITTED_NODES) {
    const n = next[node],
      o = previous?.[node];
    if (!n) {
      if (o) out[node] = { ...o };
      continue;
    }
    const mix = (a: number | undefined, b: number | undefined) =>
      a === undefined || b === undefined
        ? b
        : Math.round((weightOld * a + (1 - weightOld) * b) * 1e6) / 1e6;
    out[node] = Object.fromEntries(
      (['fold', 'raise', 'bet'] as const)
        .filter((k) => n[k] !== undefined)
        .map((k) => [k, mix(o?.[k], n[k])])
    ) as HumanCalibratedCutoffs;
  }
  return out;
}

function sized(spot: HumanCalibratedSpot, target: number): number | null {
  if (spot.minRaiseTo === null || spot.maxRaiseTo === null) return null;
  const clamped = Math.min(spot.maxRaiseTo, Math.max(spot.minRaiseTo, target));
  return spot.wholeChips
    ? Math.max(spot.minRaiseTo, Math.floor(clamped))
    : Math.round(clamped * 100) / 100;
}

/** Turn an intended response into a legal action the controller accepts. */
function legalize(
  spot: HumanCalibratedSpot,
  wanted: 'fold' | 'check' | 'call' | 'aggress',
  raiseTo: number
): Pick<HumanCalibratedDecision, 'action' | 'amount'> {
  const legal = spot.legalActions;
  let intent = wanted;
  if (intent === 'aggress') {
    const kind = legal.includes('raise') ? 'raise' : legal.includes('bet') ? 'bet' : null;
    const amount = kind ? sized(spot, raiseTo) : null;
    if (kind && amount !== null) return { action: kind, amount };
    if (legal.includes('all_in')) return { action: 'all_in' };
    intent = spot.toCall > 0 ? 'call' : 'check';
  }
  if (intent === 'call') {
    if (legal.includes('call')) return { action: 'call' };
    if (legal.includes('all_in')) return { action: 'all_in' };
    intent = 'check';
  }
  if (intent === 'check' && legal.includes('check')) return { action: 'check' };
  if (legal.includes('fold')) return { action: 'fold' };
  return { action: 'check' };
}

/**
 * One seat's decision under the human-calibrated population. Deterministic for
 * a given spot and fastRandom state (postflop equity draws from fastRandom).
 */
export function humanCalibratedDecide(
  spot: HumanCalibratedSpot,
  p: Readonly<HumanCalibratedProfile> = humanCalibratedProfileFor(spot.variant)
): HumanCalibratedDecision {
  if (p.family !== humanCalibratedFamily(spot.variant))
    throw new Error(`Profile ${p.id} does not cover ${spot.variant}`);
  const S = HUMAN_CALIBRATED_SIZING;
  if (spot.stage === 'preflop') {
    const s = humanCalibratedPreflopPercentile(spot.cards, spot.variant);
    const raiseTo = S.preflopRaiseToMultiple * spot.currentBet;
    if (spot.toCall <= 0) {
      const intent = s >= 1 - p.preflop.freeRaise ? 'aggress' : 'check';
      return { ...legalize(spot, intent, raiseTo), strength: s, node: 'preflop/free' };
    }
    const node = spot.aggressionThisStreet ? 'preflop/facing_raise' : 'preflop/unopened';
    const r = spot.aggressionThisStreet ? p.preflop.facingRaise : p.preflop.unopened;
    const t = respond(s, r, p.cutoffs?.[node]);
    return {
      ...legalize(spot, t === 'raise' ? 'aggress' : t, raiseTo),
      strength: s,
      node,
    };
  }
  if (spot.stage !== 'flop' && spot.stage !== 'turn' && spot.stage !== 'river')
    throw new Error(`No human-calibrated response at ${spot.stage}`);
  const street: PostflopStreet = spot.stage;
  const equity = simulateEquity(
    spot.cards,
    spot.board,
    1,
    variantInfo(spot.variant),
    HUMAN_CALIBRATED_POSTFLOP_ITERATIONS
  );
  const s = Math.min(0.999999, Math.max(0, equity));
  const target = p.postflop[street];
  if (spot.toCall <= 0) {
    const betFrom = p.cutoffs?.[`${street}/checked_to`]?.bet ?? 1 - target.checkedToBet;
    const intent = s >= betFrom ? 'aggress' : 'check';
    return {
      ...legalize(spot, intent, S.betPotFraction[street] * spot.pot),
      strength: s,
      node: `${street}/checked_to`,
    };
  }
  const t = respond(s, target.facingBet, p.cutoffs?.[`${street}/facing_bet`]);
  return {
    ...legalize(spot, t === 'raise' ? 'aggress' : t, S.raiseToMultiple[street] * spot.currentBet),
    strength: s,
    node: `${street}/facing_bet`,
  };
}
