/** Pure premium/commitment and continuation pricing. These are always wired
 * into the live reference; historical layer-isolation tests mock this module
 * without adding a production opt-out or rewriting retained corpus bytes. */
import type { Card } from '../types.js';
import type { PreflopCtx, PreflopIntent } from './HorsePreflop.js';
import { potLimitRaiseTo } from './BettingStructure.js';
export { estimateRangeAdvantage as rangeAdvantageFor } from './HorseEval.js';
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** Bounded call-side scenario. Future bets use this opponent's observed
 * frequency and current pot fraction. Equity is against the current range;
 * this is not a solver export or a claim about an unseen river holding. */
export interface BarrelContinuation {
  betProbability: number;
  betFraction: number;
  opponentStack: number;
  streets: number;
}

export function barrelContinuationValue(spot: {
  equity: number;
  pot: number;
  toCall: number;
  stack: number;
  continuation: BarrelContinuation;
  rakeMarg?: number;
  callDeductionFraction?: number;
  riskPremium?: number;
}): number {
  const { continuation: plan } = spot;
  const c = Math.min(spot.stack, Math.max(0, spot.toCall));
  const q = clamp(plan.betProbability, 0, 1);
  const f = Math.max(0, plan.betFraction);
  const rake = clamp(spot.rakeMarg ?? 0, 0, 0.5);
  const initialPot = spot.pot + c;
  const exact = Number.isFinite(spot.callDeductionFraction);
  const initialFee = initialPot * clamp(spot.callDeductionFraction ?? 0, 0, 1);
  const risk = clamp(spot.riskPremium ?? 0, 0, 0.15);
  const terminal = (pot: number, spent: number): number => {
    const premium = risk * Math.sqrt(spent / Math.max(1, spot.stack));
    if (!exact) return clamp(spot.equity * (1 - rake) - premium, 0, 1) * pot;
    // Charge the current award's fee once. Additional modeled bets retain
    // the existing marginal-rate approximation, including zero at the cap.
    const net = Math.max(0, pot - initialFee - Math.max(0, pot - initialPot) * rake);
    return Math.max(0, clamp(spot.equity, 0, 1) * net - premium * pot);
  };
  const value = (pot: number, hero: number, opp: number, left: number, spent: number): number => {
    if (left <= 0 || hero <= 0 || opp <= 0 || f <= 0 || q <= 0) return terminal(pot, spent);
    const bet = Math.min(f * pot, hero, opp);
    const checked = value(pot, hero, opp, left - 1, spent);
    const called = value(pot + 2 * bet, hero - bet, opp - bet, left - 1, spent + bet) - bet;
    return (1 - q) * checked + q * Math.max(0, called);
  };
  return (
    value(
      spot.pot + c,
      spot.stack - c,
      Math.max(0, plan.opponentStack),
      Math.min(2, Math.max(0, Math.floor(plan.streets))),
      c
    ) - c
  );
}

export function premiumPreflopAnchors(
  cards: Card[],
  rules: { isOmaha: boolean; isShortDeck: boolean; isFixedLimit: boolean }
) {
  const counts = new Map<string, number>(),
    suits = new Map<string, number>();
  for (const c of cards) {
    counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
    suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1);
  }
  const holdemPremiumPair =
    !rules.isOmaha &&
    !rules.isShortDeck &&
    !rules.isFixedLimit &&
    cards.length === 2 &&
    cards[0].rank === cards[1].rank &&
    (cards[0].rank === 'A' || cards[0].rank === 'K');
  const suitedPremium: 'aces' | 'kings' | undefined = rules.isOmaha
    ? counts.get('A') === 2 && cards.some((c) => c.rank === 'A' && (suits.get(c.suit) ?? 0) >= 2)
      ? 'aces'
      : counts.get('K') === 2 && [...suits.values()].filter((n) => n >= 2).length >= 2
        ? 'kings'
        : undefined
    : undefined;
  return { holdemPremiumPair, suitedPremium };
}
export function completePreflopCommitment(out: PreflopIntent, ctx: PreflopCtx): PreflopIntent {
  if (ctx.isFixedLimit === true || out.a !== 'raiseTo' || !Number.isFinite(out.to)) return out;
  const allInTo = ctx.currentBet - ctx.toCall + ctx.stack;
  const remainder = allInTo - (out.to as number);
  return remainder > 0 &&
    remainder <= Math.min(ctx.toCall, ctx.stack) &&
    (!ctx.isPotLimit || allInTo <= potLimitRaiseTo(ctx.pot, ctx.currentBet, ctx.toCall))
    ? { a: 'jam' }
    : out;
}
export function shouldPriceTerminalFlop(s: {
  enabled: boolean;
  street: string;
  fixed: boolean;
  initiative: string;
  stack: number;
  pot: number;
  raisedPreflop: boolean;
}): boolean {
  return (
    s.enabled &&
    s.street === 'flop' &&
    !s.fixed &&
    s.initiative === 'hero' &&
    s.stack > 0 &&
    s.stack < s.pot * 0.33 &&
    s.raisedPreflop
  );
}
export function makeBarrelContinuation(plan: BarrelContinuation): BarrelContinuation | undefined {
  return plan;
}
export function callContinuationValue(s: {
  equity: number;
  realization: number;
  pot: number;
  call: number;
  stack: number;
  rake: number;
  callDeductionFraction?: number;
  risk: number;
  continuation?: BarrelContinuation;
}): number {
  if (s.continuation && s.call < s.stack)
    return barrelContinuationValue({
      equity: s.equity,
      pot: s.pot,
      toCall: s.call,
      stack: s.stack,
      continuation: s.continuation,
      rakeMarg: s.rake,
      callDeductionFraction: s.callDeductionFraction,
      riskPremium: s.risk,
    });
  const r = s.call >= s.stack ? 1 : s.realization;
  return (
    clamp(
      s.equity *
        r *
        (1 -
          (Number.isFinite(s.callDeductionFraction)
            ? clamp(s.callDeductionFraction!, 0, 1)
            : s.rake)) -
        s.risk * Math.sqrt(clamp(s.call / Math.max(1, s.stack), 0, 1)),
      0,
      1
    ) *
      (s.pot + s.call) -
    s.call
  );
}
export const wagerRealization = (r: number, committed: number, effective: number) =>
  committed >= effective - 0.005 ? 1 : r;
export const continuationMixWindow = (pot: number, effective: number, fraction: number) =>
  fraction * Math.min(pot, effective || pot);
