/**
 * V64 (2026-10-31): on a single-board hold'em river, a hand in the bluff-catch
 * class (one pair, high card, or two pair that shares the board's pair) never
 * raises a wager. Measured over the latest 10,973 NLH review hands
 * (|net| >= 20bb): horse river raises holding one pair were called 85-95% of
 * the time and won 34% (cash n=109, -4,184bb); air raises won 7% (cash n=42,
 * -1,696bb); raises with two pair or better earned about +16,000bb. In the
 * engine fixture second pair (9s8d on Qh9d3s7c2c) raised a 0.7-pot river
 * wager to ~120 in 16 of 20 seeds off a 0.72+ range read while third pair
 * called. The class now falls through to the V38 call verdict (with the V61
 * shade); two pair of both hole cards and better raise exactly as before.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as EvEngine from './HorseEvEngine.js';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit, SeatPlayer } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}
const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

/** Villain bets `bet` into a pot of `base` on `stage` after check-check on the earlier streets. */
function facing(
  variant: string,
  hole: string,
  board: string,
  bet: number,
  mode = 'cash',
  base = 40,
  stage: 'flop' | 'turn' | 'river' = 'river'
) {
  const players: SeatPlayer[] = [
    {
      seat: 1,
      user_id: 'hero',
      username: 'h',
      stack: 400,
      bet: 0,
      totalInvested: 10,
      cards: cards(hole),
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
    {
      seat: 2,
      user_id: 'villain',
      username: 'v',
      stack: 400 - bet,
      bet,
      totalInvested: 10 + bet,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    },
  ];
  const history: Array<Record<string, unknown>> = [
    { stage: 'preflop', seat: 2, userId: 'villain', action: 'raise', amount: 6, timestamp: 1 },
    { stage: 'preflop', seat: 1, userId: 'hero', action: 'call', amount: 4, timestamp: 2 },
  ];
  const earlier = stage === 'river' ? ['flop', 'turn'] : stage === 'turn' ? ['flop'] : [];
  for (const st of earlier) {
    history.push({ stage: st, seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 3 });
    history.push({ stage: st, seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: 4 });
  }
  history.push({ stage, seat: 2, userId: 'villain', action: 'bet', amount: bet, timestamp: 5 });
  return {
    hero: players[0],
    gs: {
      players,
      communityCards: cards(board),
      pot: base + bet,
      currentBet: bet,
      minRaise: Math.max(2, bet),
      stage,
      gameVariant: variant,
      gameMode: mode,
      bigBlind: 2,
      dealerSeat: 1,
      actionHistory: history,
    },
  };
}

const river = (variant: string, hole: string, board: string, bet: number, mode = 'cash', base = 40) =>
  facing(variant, hole, board, bet, mode, base, 'river');

function decideSeeds(
  spot: () => ReturnType<typeof facing>,
  opts: Record<string, unknown>,
  seeds = 20
) {
  const actions: string[] = [];
  let verdicts = 0;
  let redirects = 0;
  for (let i = 0; i < seeds; i++) {
    seedFastRandom(0x64000 + i);
    HorseMind.reset();
    drainFires();
    const spy = vi.spyOn(EvEngine, 'riverCallVerdict');
    try {
      const s = spot();
      const d = HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
        telemetry: true,
        mind: false,
        ...opts,
      } as never);
      actions.push(d.action);
      verdicts += spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
    redirects += fires()['v64_river_raise_needs_two_pair'] ?? 0;
  }
  const raises = actions.filter((a) => a === 'raise' || a === 'all_in').length;
  return { actions, raises, verdicts, redirects };
}

describe('V64: a hold em bluff-catcher never raises the river', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed64);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  // The measured fixture: 9s8d on Qh9d3s7c2c, villain bets 28 into 40 after
  // check-check flop and turn, hero 400 behind, cash 2bb blinds.
  const secondPair = () => river('nlh', '9s8d', 'Qh9d3s7c2c', 28);
  const twoPair = () => river('nlh', 'Qs9c', 'Qh9d3s7c2c', 28);

  it('second pair facing 28 into 40 reaches the river call verdict and never raises across 20 seeds', () => {
    const on = decideSeeds(secondPair, {});
    expect(on.raises).toBe(0);
    expect(on.verdicts).toBe(20);
    expect(on.redirects).toBeGreaterThanOrEqual(16);
    for (const a of on.actions) expect(['call', 'fold']).toContain(a);
  });

  it('with v64RiverRaiseNeedsTwoPair false the old second-pair raise returns', () => {
    const off = decideSeeds(secondPair, { v64RiverRaiseNeedsTwoPair: false });
    expect(off.raises).toBeGreaterThanOrEqual(12);
    expect(off.redirects).toBe(0);
    // every raise skipped the call verdict, as before
    expect(off.verdicts).toBeLessThanOrEqual(20 - off.raises);
  });

  it('two pair of both hole cards keeps raising at the old frequency', () => {
    const on = decideSeeds(twoPair, {});
    const off = decideSeeds(twoPair, { v64RiverRaiseNeedsTwoPair: false });
    expect(on.redirects).toBe(0);
    expect(off.redirects).toBe(0);
    expect(on.raises).toBeGreaterThanOrEqual(12);
    expect(on.raises).toBe(off.raises);
    expect(on.actions).toEqual(off.actions);
  });

  it('a set and top pair plus board pair are read as the law reads them', () => {
    // a set raises as before
    const set = decideSeeds(() => river('nlh', '3h3d', 'Qh9d3s7c2c', 28), {});
    expect(set.redirects).toBe(0);
    expect(set.raises).toBeGreaterThanOrEqual(12);
    // two pair that shares the board's pair is a bluff-catcher
    const boardPaired = decideSeeds(() => river('nlh', 'Qs4d', 'Qh9d3s9c7c', 28), {});
    expect(boardPaired.raises).toBe(0);
    expect(boardPaired.verdicts).toBe(20);
  });

  it('ace high with the nut blocker never bluff-raises the river wager', () => {
    // AhKs on Qh9h3h7c2c: ace-high, blocks the nut flush, the V8 blocker
    // raise-bluff's exact trigger. The blocker read needs the mind on; 200
    // seeds so the 0.35 * bluffFreq roll fires several times with the gate
    // off (measured 26 of 300 before V64).
    const air = () => river('nlh', 'AhKs', 'Qh9h3h7c2c', 20);
    const on = decideSeeds(air, { mind: true }, 200);
    expect(on.raises).toBe(0);
    expect(on.verdicts).toBe(200);
    const off = decideSeeds(air, { mind: true, v64RiverRaiseNeedsTwoPair: false }, 200);
    expect(off.raises).toBeGreaterThan(0);
    expect(on.redirects).toBeGreaterThanOrEqual(off.raises);
  });

  it('Omaha is unchanged', () => {
    const spot = () => river('plo4', '9s8d7h2s', 'Qh9d3s7c2c', 28);
    const on = decideSeeds(spot, {});
    const off = decideSeeds(spot, { v64RiverRaiseNeedsTwoPair: false });
    expect(on.redirects).toBe(0);
    expect(on.actions).toEqual(off.actions);
  });

  it('flop and turn are unchanged', () => {
    for (const stage of ['flop', 'turn'] as const) {
      const board = stage === 'flop' ? 'Qh9d3s' : 'Qh9d3s7c';
      const spot = () => facing('nlh', '9s8d', board, 28, 'cash', 40, stage);
      const on = decideSeeds(spot, {});
      const off = decideSeeds(spot, { v64RiverRaiseNeedsTwoPair: false });
      expect(on.redirects).toBe(0);
      expect(on.actions).toEqual(off.actions);
      expect(on.verdicts).toBe(0);
    }
  });

  it('applies in tournaments too', () => {
    const on = decideSeeds(() => river('nlh', '9s8d', 'Qh9d3s7c2c', 28, 'tournament'), {});
    expect(on.raises).toBe(0);
    expect(on.verdicts).toBe(20);
  });
});
