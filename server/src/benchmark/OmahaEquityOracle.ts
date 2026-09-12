import type { Card } from '../types.js';
import {
  OMAHA_REFERENCE_VERSION,
  cardKey,
  contributionLayers,
  physicalBoardCards,
  referenceDeck,
  referenceVariant,
  settleOmahaReference,
  uniqueCards,
  type OmahaVariant,
  type ReferencePlayer,
} from './OmahaReference.js';

export const OMAHA_EQUITY_LIMITS = {
  maxSamples: 4096,
  maxExactDeals: 4096,
  maxCombos: 256,
  attemptsPerSample: 128,
  maxPlayers: 8,
  maxBoards: 3,
} as const;
export type OmahaRange = { uniform: true } | { combos: { cards: Card[]; weight: number }[] };
export interface OmahaEquityRequest {
  variant: OmahaVariant;
  heroId: string;
  players: { id: string; seat: number; contributed: number; folded?: boolean; range: OmahaRange }[];
  boards: Card[][];
  sharedPrefixLength?: number;
  deadCards?: Card[];
  dealerSeat: number;
  chipUnit: 0.01 | 1;
  mode: 'sampled' | 'exact_river';
  samples: number;
  seed: number;
}
export interface OmahaEquityResult {
  version: string;
  variant: OmahaVariant;
  seed: number;
  method: 'joint_range_rejection_monte_carlo' | 'weighted_exact_river';
  complete: boolean;
  reason: 'complete' | 'cancelled' | 'range_attempt_budget' | 'incompatible_ranges';
  samples: number;
  attempts: number;
  requestedSamples: number;
  excludedCombos: number;
  equity: number;
  highEquity: number;
  lowEquity: number;
  expectedChips: number;
  guaranteedShare: number | null;
  possibleFreeroll: boolean | null;
  scoopProbability: number;
  quarterOrLessProbability: number;
  zeroProbability: number;
  standardError: number | null;
  confidence99: [number, number];
  distribution: { share: number; probability: number }[];
  perBoard: { highEquity: number; lowEquity: number; equity: number }[];
  boardCovariance: number[][];
  eligiblePot: number;
  refunds: Record<string, number>;
  maxConservationError: number;
  elapsedMs: number;
}

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
type PreparedPlayer = OmahaEquityRequest['players'][number] & {
  combos: { cards: Card[]; weight: number }[] | null;
};
export async function evaluateOmahaEquity(
  request: OmahaEquityRequest,
  shouldContinue: () => boolean = () => true
): Promise<OmahaEquityResult> {
  const started = performance.now();
  const rules = referenceVariant(request.variant);
  if (
    !['sampled', 'exact_river'].includes(request.mode) ||
    !Number.isSafeInteger(request.seed) ||
    request.seed < 1 ||
    request.seed > 0xffffffff ||
    !Number.isInteger(request.samples) ||
    request.samples < 1 ||
    request.samples > OMAHA_EQUITY_LIMITS.maxSamples
  )
    throw new Error('Invalid Omaha evidence mode, seed or sample budget');
  if (
    !Array.isArray(request.players) ||
    request.players.length < 2 ||
    request.players.length > OMAHA_EQUITY_LIMITS.maxPlayers ||
    !Number.isInteger(request.dealerSeat) ||
    request.dealerSeat < 0 ||
    request.dealerSeat > 10
  )
    throw new Error('Invalid player or button count');
  const boardCards = physicalBoardCards(request.boards, request.sharedPrefixLength);
  if (request.boards.some((b) => ![0, 3, 4, 5].includes(b.length)))
    throw new Error('Unsupported board street');
  const known = [...boardCards, ...(request.deadCards ?? [])];
  uniqueCards(known);
  const blocked = new Set(known.map(cardKey));
  const { pots, refunds } = contributionLayers(
    request.players.map((p) => ({ ...p, cards: [] })),
    request.chipUnit
  );
  if (!request.players.some((p) => p.id === request.heroId && !p.folded))
    throw new Error('Active hero is required');
  const eligiblePot = pots
    .filter((p) => p.eligible.includes(request.heroId))
    .reduce((s, p) => s + p.amount, 0);
  if (!(eligiblePot > 0)) throw new Error('Hero has no contestable pot');
  let excludedCombos = 0;
  const players: PreparedPlayer[] = request.players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      if ('uniform' in p.range) {
        if (p.range.uniform !== true || Object.keys(p.range).length !== 1)
          throw new Error('Invalid uniform range');
        return { ...p, combos: null };
      }
      if (
        !Array.isArray(p.range.combos) ||
        !p.range.combos.length ||
        p.range.combos.length > OMAHA_EQUITY_LIMITS.maxCombos
      )
        throw new Error('Invalid combination range size');
      const seen = new Set<string>();
      const combos = p.range.combos
        .map((combo) => {
          if (
            combo.cards.length !== rules.holes ||
            !Number.isFinite(combo.weight) ||
            combo.weight <= 0 ||
            combo.weight > 1e9
          )
            throw new Error('Invalid weighted hole combination');
          uniqueCards(combo.cards);
          const key = combo.cards.map(cardKey).sort().join('|');
          if (seen.has(key)) throw new Error('Duplicate range combination');
          seen.add(key);
          return { cards: combo.cards.slice(), weight: combo.weight, key };
        })
        .filter((combo) => {
          const possible = combo.cards.every((c) => !blocked.has(cardKey(c)));
          if (!possible) excludedCombos++;
          return possible;
        })
        .sort((a, b) => a.key.localeCompare(b.key));
      if (!combos.length) throw new Error('Range has no physically possible combination');
      const total = combos.reduce((s, c) => s + c.weight, 0);
      if (combos.some((c) => c.weight / total === 0))
        throw new Error('Range weight precision exhausted');
      return { ...p, combos: combos.map((c) => ({ cards: c.cards, weight: c.weight / total })) };
    });
  const missing = request.boards.reduce((s, b) => s + 5 - b.length, 0);
  if (known.length + players.length * rules.holes + missing > 52)
    throw new Error('The shared deck cannot serve this scenario');
  const exact = request.mode === 'exact_river';
  const combinations = players.reduce((n, p) => n * (p.combos?.length ?? Infinity), 1);
  if (exact && (missing !== 0 || combinations > OMAHA_EQUITY_LIMITS.maxExactDeals))
    throw new Error('Exact river mode needs complete boards and a bounded explicit joint range');
  const result: OmahaEquityResult = {
    version: OMAHA_REFERENCE_VERSION,
    variant: request.variant,
    seed: request.seed,
    method: exact ? 'weighted_exact_river' : 'joint_range_rejection_monte_carlo',
    complete: false,
    reason: 'complete',
    samples: 0,
    attempts: 0,
    requestedSamples: exact ? combinations : request.samples,
    excludedCombos,
    equity: 0,
    highEquity: 0,
    lowEquity: 0,
    expectedChips: 0,
    guaranteedShare: null,
    possibleFreeroll: null,
    scoopProbability: 0,
    quarterOrLessProbability: 0,
    zeroProbability: 0,
    standardError: null,
    confidence99: [0, 1],
    distribution: [],
    perBoard: request.boards.map(() => ({ highEquity: 0, lowEquity: 0, equity: 0 })),
    boardCovariance: request.boards.map(() => request.boards.map(() => 0)),
    eligiblePot,
    refunds,
    maxConservationError: 0,
    elapsedMs: 0,
  };
  const histogram = new Map<string, { share: number; weight: number }>();
  const random = seeded(request.seed);
  let totalWeight = 0,
    sumSquare = 0,
    minimum = 1,
    maximum = 0;
  const boardProducts = request.boards.map(() => request.boards.map(() => 0));
  const target = exact ? combinations : request.samples;
  const maxAttempts = exact
    ? combinations
    : request.samples * OMAHA_EQUITY_LIMITS.attemptsPerSample;
  for (let iteration = 0; iteration < maxAttempts; iteration++) {
    if (iteration % 16 === 0) {
      if (!shouldContinue()) {
        result.reason = 'cancelled';
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    result.attempts++;
    const used = new Set(blocked);
    const dealt = new Map<string, Card[]>();
    let weight = 1,
      ordinal = iteration,
      valid = true;
    // Pick every explicit range from its independent prior, then reject the
    // whole tuple on collision. Sequential per-seat renormalization is biased.
    for (const p of players.filter((p) => p.combos)) {
      const combos = p.combos!;
      let selected = combos[combos.length - 1];
      if (exact) {
        selected = combos[ordinal % combos.length];
        ordinal = Math.floor(ordinal / combos.length);
        weight *= selected.weight;
      } else {
        const draw = random();
        let cdf = 0;
        for (const c of combos) {
          cdf += c.weight;
          if (draw < cdf) {
            selected = c;
            break;
          }
        }
      }
      dealt.set(p.id, selected.cards);
      for (const card of selected.cards) {
        const key = cardKey(card);
        if (used.has(key)) valid = false;
        used.add(key);
      }
    }
    if (!valid) continue;
    if (!(weight > 0)) throw new Error('Joint range weight precision exhausted');
    const deck = referenceDeck().filter((c) => !used.has(cardKey(c)));
    function draw(count: number): Card[] {
      const cards: Card[] = [];
      for (let i = 0; i < count; i++)
        cards.push(deck.splice(Math.floor(random() * deck.length), 1)[0]);
      return cards;
    }
    for (const p of players.filter((p) => !p.combos)) dealt.set(p.id, draw(rules.holes));
    const boards = request.boards.map((b) => [...b, ...draw(5 - b.length)]);
    const seated: ReferencePlayer[] = players.map((p) => ({
      id: p.id,
      seat: p.seat,
      contributed: p.contributed,
      folded: p.folded,
      cards: dealt.get(p.id)!,
    }));
    const settlement = settleOmahaReference({
      variant: request.variant,
      players: seated,
      boards,
      sharedPrefixLength: request.sharedPrefixLength,
      chipUnit: request.chipUnit,
      dealerSeat: request.dealerSeat,
    });
    const high =
      settlement.awards
        .filter((a) => a.playerId === request.heroId && a.half === 'high')
        .reduce((s, a) => s + a.amount, 0) / eligiblePot;
    const low =
      settlement.awards
        .filter((a) => a.playerId === request.heroId && a.half === 'low')
        .reduce((s, a) => s + a.amount, 0) / eligiblePot;
    const share = high + low;
    const key = share.toFixed(12);
    const bin = histogram.get(key) ?? { share, weight: 0 };
    bin.weight += weight;
    histogram.set(key, bin);
    result.samples++;
    totalWeight += weight;
    result.equity += weight * share;
    result.highEquity += weight * high;
    result.lowEquity += weight * low;
    result.scoopProbability += weight * Number(Math.abs(share - 1) < 1e-9);
    result.quarterOrLessProbability += weight * Number(share > 0 && share <= 0.25 + 1e-9);
    result.zeroProbability += weight * Number(share === 0);
    sumSquare += weight * share * share;
    minimum = Math.min(minimum, share);
    maximum = Math.max(maximum, share);
    result.maxConservationError = Math.max(
      result.maxConservationError,
      Math.abs(settlement.contributed - settlement.distributed)
    );
    const boardShares = boards.map((_, index) => {
      const boardPot = settlement.pots
        .filter((p) => p.eligible.includes(request.heroId))
        .reduce((s, pot) => {
          const units = Math.round(pot.amount / request.chipUnit);
          return (
            s +
            (Math.floor(units / boards.length) + Number(index < units % boards.length)) *
              request.chipUnit
          );
        }, 0);
      const awards = settlement.awards.filter(
        (a) => a.playerId === request.heroId && a.boardIndex === index
      );
      const hi = boardPot
        ? awards.filter((a) => a.half === 'high').reduce((s, a) => s + a.amount, 0) / boardPot
        : 0;
      const lo = boardPot
        ? awards.filter((a) => a.half === 'low').reduce((s, a) => s + a.amount, 0) / boardPot
        : 0;
      result.perBoard[index].highEquity += weight * hi;
      result.perBoard[index].lowEquity += weight * lo;
      result.perBoard[index].equity += weight * (hi + lo);
      return hi + lo;
    });
    boardShares.forEach((a, i) =>
      boardShares.forEach((b, j) => {
        boardProducts[i][j] += weight * a * b;
      })
    );
    if (!exact && result.samples === target) break;
  }
  result.complete =
    result.reason !== 'cancelled' &&
    (exact ? result.attempts === target && result.samples > 0 : result.samples === target);
  if (!result.complete && result.reason !== 'cancelled')
    result.reason = result.samples ? 'range_attempt_budget' : 'incompatible_ranges';
  if (totalWeight > 0) {
    for (const field of [
      'equity',
      'highEquity',
      'lowEquity',
      'scoopProbability',
      'quarterOrLessProbability',
      'zeroProbability',
    ] as const)
      result[field] /= totalWeight;
    result.expectedChips = result.equity * eligiblePot + (refunds[request.heroId] ?? 0);
    result.distribution = [...histogram.values()]
      .map((b) => ({ share: b.share, probability: b.weight / totalWeight }))
      .sort((a, b) => a.share - b.share);
    result.perBoard.forEach((b) => {
      b.highEquity /= totalWeight;
      b.lowEquity /= totalWeight;
      b.equity /= totalWeight;
    });
    result.boardCovariance = boardProducts.map((row, i) =>
      row.map((v, j) => v / totalWeight - result.perBoard[i].equity * result.perBoard[j].equity)
    );
    if (exact && result.complete) {
      result.guaranteedShare = minimum;
      result.possibleFreeroll = minimum >= 0.5 && maximum > minimum;
      result.standardError = 0;
      result.confidence99 = [result.equity, result.equity];
    } else if (!exact && result.samples > 1) {
      result.standardError = Math.sqrt(
        Math.max(0, sumSquare / totalWeight - result.equity ** 2) / (result.samples - 1)
      );
      // Distribution-free Hoeffding interval for bounded pot shares. Small
      // samples cannot manufacture certainty when no rare event was observed.
      const width = Math.sqrt(Math.log(200) / (2 * result.samples));
      result.confidence99 = [
        Math.max(0, result.equity - width),
        Math.min(1, result.equity + width),
      ];
    }
  }
  result.elapsedMs = performance.now() - started;
  return result;
}
