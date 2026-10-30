/**
 * V61 (2026-10-29): a hold'em one-pair river call is a bluff-catch, and the
 * range read it was priced against was too bluff-heavy. Measured over 14 days
 * of NLH review stack-offs (cash and tournament): one-pair and board-paired
 * two-pair river calls won 17-18% under a quarter pot, 21-22% at a quarter to
 * a half and 14% at a half to a full pot, against the 20/29/40% the price
 * demands. The shade lowers the equity handed to the V38 MDF verdict by
 * 6-12 points with the price, only when the bettor does not read as an
 * over-bluffer, only in single-board hold'em, and never for a made hand
 * above the bluff-catch class.
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

function river(variant: string, hole: string, board: string, bet: number, mode = 'cash') {
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
  for (const st of ['flop', 'turn']) {
    history.push({ stage: st, seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 3 });
    history.push({ stage: st, seat: 2, userId: 'villain', action: 'check', amount: 0, timestamp: 4 });
  }
  history.push({ stage: 'river', seat: 2, userId: 'villain', action: 'bet', amount: bet, timestamp: 5 });
  return {
    hero: players[0],
    gs: {
      players,
      communityCards: cards(board),
      pot: 20 + bet,
      currentBet: bet,
      minRaise: Math.max(2, bet),
      stage: 'river',
      gameVariant: variant,
      gameMode: mode,
      bigBlind: 2,
      dealerSeat: 1,
      actionHistory: history,
    },
  };
}

/** The equity the V38 river verdict was handed, with the given options. */
function verdictEquity(s: ReturnType<typeof river>, opts: Record<string, unknown>) {
  const spy = vi.spyOn(EvEngine, 'riverCallVerdict');
  try {
    HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
      telemetry: true,
      mind: false,
      ...opts,
    } as never);
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0][0].equity;
  } finally {
    spy.mockRestore();
  }
}

describe('V61: a hold em one-pair river call is shaded against the price', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed61);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  it('second pair facing a pot-sized river bet is priced 12 points below the unshaded read', () => {
    const on = verdictEquity(river('nlh', '9s8d', 'Qh9d3s7c2c', 20), {});
    expect(fires()['v61_river_one_pair_shade']).toBe(1);
    seedFastRandom(0x5eed61);
    const off = verdictEquity(river('nlh', '9s8d', 'Qh9d3s7c2c', 20), {
      v61RiverOnePairShade: false,
    });
    expect(fires()['v61_river_one_pair_shade']).toBeUndefined();
    expect(off - on).toBeCloseTo(0.12, 2);
  });

  it('applies in tournaments too, and to ace high and to two pair that shares the board pair', () => {
    verdictEquity(river('nlh', '9s8d', 'Qh9d3s7c2c', 20, 'tournament'), {});
    expect(fires()['v61_river_one_pair_shade']).toBe(1);
    verdictEquity(river('nlh', 'AhKh', 'Qh9d3s7c2c', 20), {});
    expect(fires()['v61_river_one_pair_shade']).toBe(1);
    verdictEquity(river('nlh', '7s4d', 'Qh9d3s9c7c', 20), {});
    expect(fires()['v61_river_one_pair_shade']).toBe(1);
  });

  it('a set, two pair of hero own cards, and Omaha keep the unshaded read', () => {
    const decide = (variant: string, hole: string, board: string) => {
      HorseLogic.decide(river(variant, hole, board, 20).hero, river(variant, hole, board, 20).gs as never, 'balanced', {}, {
        telemetry: true,
        mind: false,
      } as never);
      return fires()['v61_river_one_pair_shade'];
    };
    expect(decide('nlh', '3h3d', 'Qh9d3s7c2c')).toBeUndefined();
    expect(decide('nlh', 'Qs9c', 'Qh9d3s7c2c')).toBeUndefined();
    expect(decide('plo4', '9s8d7h2s', 'Qh9d3s7c2c')).toBeUndefined();
  });
});
