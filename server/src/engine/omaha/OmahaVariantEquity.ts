import type { SeatPlayer } from '../../types.js';
import type { HorseEquityOutcomeSample } from '../HorseEval.js';
import { calculatePots } from '../PokerEngine.js';
import { isOmahaPolicyVariant, type OmahaPolicyVariant } from './OmahaVariantPolicyPack.js';

export interface OmahaVariantEquityEvidence {
  analysisMs: number;
  equity: number;
  highEquity: number;
  lowEquity: number;
  samples: number;
  standardError: number;
  confidence99: [number, number];
  scoopProbability: number;
  quarterOrLessProbability: number;
  sixthOrLessProbability: number;
  eligiblePot: number;
  expectedChips: number;
  minimumObservedShare: number;
  maximumObservedShare: number;
  distribution: { share: number; probability: number }[];
  perPot: {
    amount: number;
    eligiblePlayers: string[];
    highEquity: number;
    lowEquity: number;
    equity: number;
  }[];
  decisionEquityCeiling?: number;
  requestedSamples?: number;
  sampleBudgetExhausted?: boolean;
  provenance:
    | 'existing_joint_deck_showdowns'
    | 'independent_offline_oracle'
    | 'variant_public_line_joint_deck';
}

/** External reference evidence must reconcile to the complete eligible pot;
 * malformed/partial distributions cannot authorize a candidate action. */
export function validOmahaVariantEquity(
  e: OmahaVariantEquityEvidence | null,
  eligiblePot: number
): e is OmahaVariantEquityEvidence {
  if (
    !e ||
    !Number.isInteger(e.samples) ||
    e.samples < 1 ||
    e.samples > 4096 ||
    !Number.isFinite(e.analysisMs) ||
    e.analysisMs < 0 ||
    !Number.isFinite(e.standardError) ||
    e.standardError < 0 ||
    !Array.isArray(e.confidence99) ||
    e.confidence99.length !== 2 ||
    !Array.isArray(e.distribution) ||
    !e.distribution.length ||
    e.distribution.length > 4096 ||
    !Array.isArray(e.perPot) ||
    !e.perPot.length ||
    e.perPot.length > 10 ||
    ![
      e.equity,
      e.highEquity,
      e.lowEquity,
      e.scoopProbability,
      e.quarterOrLessProbability,
      e.sixthOrLessProbability,
      e.minimumObservedShare,
      e.maximumObservedShare,
      ...e.confidence99,
    ].every((v) => Number.isFinite(v) && v >= 0 && v <= 1 + 1e-9) ||
    !Number.isFinite(e.eligiblePot) ||
    Math.abs(e.eligiblePot - eligiblePot) > 0.011 ||
    !Number.isFinite(e.expectedChips) ||
    Math.abs(e.expectedChips - e.equity * eligiblePot) > 0.011 ||
    e.confidence99[0] > e.equity + 1e-9 ||
    e.confidence99[1] < e.equity - 1e-9 ||
    Math.abs(e.highEquity + e.lowEquity - e.equity) > 1e-8 ||
    e.minimumObservedShare > e.maximumObservedShare ||
    e.sixthOrLessProbability > e.quarterOrLessProbability + 1e-9
  )
    return false;
  if (
    e.distribution.some(
      (b) =>
        !Number.isFinite(b.share) ||
        b.share < 0 ||
        b.share > 1 + 1e-9 ||
        !Number.isFinite(b.probability) ||
        b.probability <= 0 ||
        b.probability > 1 + 1e-9
    ) ||
    Math.abs(e.distribution.reduce((n, b) => n + b.probability, 0) - 1) > 1e-8 ||
    Math.abs(e.distribution.reduce((n, b) => n + b.share * b.probability, 0) - e.equity) > 1e-8
  )
    return false;
  return (
    e.perPot.every(
      (p) =>
        Number.isFinite(p.amount) &&
        p.amount > 0 &&
        Array.isArray(p.eligiblePlayers) &&
        p.eligiblePlayers.length > 0 &&
        [p.highEquity, p.lowEquity, p.equity].every(
          (n) => Number.isFinite(n) && n >= 0 && n <= 1 + 1e-9
        ) &&
        Math.abs(p.highEquity + p.lowEquity - p.equity) < 1e-8
    ) &&
    Math.abs(e.perPot.reduce((n, p) => n + p.amount, 0) - eligiblePot) <= 0.011 &&
    Math.abs(e.perPot.reduce((n, p) => n + p.amount * p.equity, 0) - e.expectedChips) <= 0.011
  );
}

/** Price the hero's actual call against only each pot's eligible winners.
 * Scores come from the existing joint-deck sampler; no extra cards, sampling,
 * I/O or chip mutations occur here. High/low values are shares of the whole
 * eligible pot and therefore sum to combined equity, even on no-low runouts.
 */
export function omahaVariantEquityFromShowdowns(input: {
  variant: OmahaPolicyVariant;
  players: SeatPlayer[];
  heroId: string;
  callCost: number;
  opponentIds: string[];
  samples: HorseEquityOutcomeSample[];
}): OmahaVariantEquityEvidence | null {
  const started = performance.now();
  const { heroId, opponentIds, samples } = input;
  const hero = input.players.find((p) => p.user_id === heroId);
  if (
    !isOmahaPolicyVariant(input.variant) ||
    input.players.length < 2 ||
    input.players.length > 10 ||
    !hero ||
    hero.is_folded ||
    hero.is_sitting_out ||
    !Number.isFinite(input.callCost) ||
    input.callCost < 0 ||
    input.callCost > hero.stack ||
    samples.length < 1 ||
    samples.length > 160 ||
    new Set(opponentIds).size !== opponentIds.length ||
    opponentIds.includes(heroId) ||
    new Set(input.players.map((p) => p.user_id)).size !== input.players.length ||
    input.players.some(
      (p) =>
        ![
          p.stack,
          p.bet,
          p.totalInvested,
          p.deadInvested ?? 0,
          p.individualAnteInvested ?? 0,
        ].every((n) => Number.isFinite(n) && n >= 0) ||
        (p.deadInvested ?? 0) > p.totalInvested ||
        (p.individualAnteInvested ?? 0) > (p.deadInvested ?? 0)
    )
  )
    return null;
  const players = input.players.map((p) =>
    p.user_id === heroId
      ? {
          ...p,
          stack: p.stack - input.callCost,
          bet: p.bet + input.callCost,
          totalInvested: p.totalInvested + input.callCost,
        }
      : p
  );
  const pots = calculatePots(players).filter((p) => p.eligiblePlayers.includes(heroId));
  const eligiblePot = pots.reduce((sum, p) => sum + p.amount, 0);
  if (
    !(eligiblePot > 0) ||
    pots.some((p) => p.eligiblePlayers.some((id) => id !== heroId && !opponentIds.includes(id)))
  )
    return null;
  const perPot = pots.map((p) => ({
    ...p,
    eligiblePlayers: [...p.eligiblePlayers].sort(),
    highEquity: 0,
    lowEquity: 0,
    equity: 0,
  }));
  let high = 0,
    low = 0,
    square = 0,
    scoops = 0,
    quarters = 0,
    sixths = 0;
  let minimum = 1,
    maximum = 0;
  const histogram = new Map<number, number>();
  for (const sample of samples) {
    if (
      !Number.isFinite(sample.heroHigh) ||
      sample.opponentHigh.length !== opponentIds.length ||
      sample.opponentLow.length !== opponentIds.length ||
      sample.opponentHigh.some((n) => !Number.isFinite(n)) ||
      [sample.heroLow, ...sample.opponentLow].some((n) => n !== null && !Number.isFinite(n))
    )
      return null;
    let highAward = 0,
      lowAward = 0;
    for (const pot of perPot) {
      const scores = pot.eligiblePlayers.map((id) =>
        id === heroId
          ? { id, high: sample.heroHigh, low: sample.heroLow }
          : {
              id,
              high: sample.opponentHigh[opponentIds.indexOf(id)],
              low: sample.opponentLow[opponentIds.indexOf(id)],
            }
      );
      const bestHigh = Math.max(...scores.map((s) => s.high));
      const highWinners = scores.filter((s) => s.high === bestHigh);
      const lows = input.variant === 'plo8' ? scores.filter((s) => s.low !== null) : [];
      const bestLow = lows.length ? Math.min(...lows.map((s) => s.low!)) : null;
      const lowWinners = bestLow === null ? [] : lows.filter((s) => s.low === bestLow);
      const hi = highWinners.some((s) => s.id === heroId)
        ? (lowWinners.length ? 0.5 : 1) / highWinners.length
        : 0;
      const lo = lowWinners.some((s) => s.id === heroId) ? 0.5 / lowWinners.length : 0;
      pot.highEquity += hi;
      pot.lowEquity += lo;
      pot.equity += hi + lo;
      highAward += pot.amount * hi;
      lowAward += pot.amount * lo;
    }
    const share = (highAward + lowAward) / eligiblePot;
    high += highAward / eligiblePot;
    low += lowAward / eligiblePot;
    square += share * share;
    if (share >= 1 - 1e-9) scoops++;
    if (share > 0 && share <= 0.25 + 1e-9) quarters++;
    if (share > 0 && share <= 1 / 6 + 1e-9) sixths++;
    minimum = Math.min(minimum, share);
    maximum = Math.max(maximum, share);
    histogram.set(share, (histogram.get(share) ?? 0) + 1);
  }
  const n = samples.length;
  const equity = (high + low) / n;
  const variance = n > 1 ? Math.max(0, (square - n * equity * equity) / (n - 1)) : 0.25;
  // Bounded pot shares use Hoeffding's 99% bound. All-win/all-loss samples
  // must not manufacture zero uncertainty for an unobserved population.
  const radius = Math.sqrt(Math.log(200) / (2 * n));
  return {
    analysisMs: performance.now() - started,
    equity,
    highEquity: high / n,
    lowEquity: low / n,
    samples: n,
    standardError: Math.sqrt(variance / n),
    confidence99: [Math.max(0, equity - radius), Math.min(1, equity + radius)],
    scoopProbability: scoops / n,
    quarterOrLessProbability: quarters / n,
    sixthOrLessProbability: sixths / n,
    eligiblePot,
    expectedChips: equity * eligiblePot,
    minimumObservedShare: minimum,
    maximumObservedShare: maximum,
    distribution: [...histogram]
      .sort(([a], [b]) => a - b)
      .map(([share, count]) => ({ share, probability: count / n })),
    perPot: perPot.map((p) => ({
      ...p,
      highEquity: p.highEquity / n,
      lowEquity: p.lowEquity / n,
      equity: p.equity / n,
    })),
    provenance: 'existing_joint_deck_showdowns',
  };
}
