/**
 * V62 (2026-10-30): the range model behind a hold'em river call. The V12/V16
 * contact sampler priced a river wager against "any pair that connected" and,
 * on a dry board, against the band's mass of air that never bets - which is
 * why one-pair river calls won 14-22% against prices demanding 20-40%
 * (checklist item 13; V61 is the price shade, this is the model). A river
 * bettor's hand is now drawn from a target stratum: a bluff by the size
 * class's bluff share, otherwise two pair or better, top pair / an overpair
 * or a weaker pair by the size class's value mix, placed exactly from a
 * per-call index of the band on this board.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as EvEngine from './HorseEvEngine.js';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import {
  seedFastRandom,
  simulateEquity,
  variantInfo,
  buildV62StratumIndex,
  v62ValueClass,
  v62SizeClass,
  v62TargetClass,
  V62_BLUFF_SHARE,
  V62_VALUE_MIX,
  V62_FALLBACK,
  type OppPostflopRead,
} from './HorseEval.js';
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
const NLH = variantInfo('nlh');

describe('V62 classification', () => {
  const board = cards('Kc7s2d4h9s');
  it('classes a sampled river hand by what a bettor would value it as', () => {
    expect(v62ValueClass(cards('Kh7d'), board, false)).toBe(3); // two pair
    expect(v62ValueClass(cards('7h7d'), board, false)).toBe(3); // set
    expect(v62ValueClass(cards('AhKd'), board, false)).toBe(2); // top pair
    expect(v62ValueClass(cards('AhAd'), board, false)).toBe(2); // overpair
    expect(v62ValueClass(cards('9h8d'), board, false)).toBe(1); // middle pair
    expect(v62ValueClass(cards('JhJd'), board, false)).toBe(1); // underpair to the king
    expect(v62ValueClass(cards('AhQd'), board, false)).toBe(0); // ace high
    // a hand that only plays the board's pair is not a made hand of its own
    expect(v62ValueClass(cards('3h6d'), cards('Kc7s2d7h9s'), false)).toBe(0);
  });

  it('size class: a raise or a wager from 0.7 pot is large, 0.4-0.7 medium, below small', () => {
    const base: OppPostflopRead = { aggrW: 0.2, checked: 0, lastStage: 'river' };
    expect(v62SizeClass({ ...base, lastFrac: 0.33 })).toBe(0);
    expect(v62SizeClass({ ...base, lastFrac: 0.5 })).toBe(1);
    expect(v62SizeClass({ ...base, lastFrac: 0.75 })).toBe(2);
    expect(v62SizeClass({ ...base, lastFrac: 0.33, raised: true })).toBe(2);
    expect(v62SizeClass({ ...base, lastFrac: 0.33, bigBet: true })).toBe(2);
    expect(v62SizeClass(base)).toBe(1);
  });

  it('target strata follow the bluff share and the value mix', () => {
    for (const sc of [0, 1, 2] as const) {
      expect(v62TargetClass(sc, V62_BLUFF_SHARE[sc] - 1e-9, 0.5)).toBe(0);
      expect(v62TargetClass(sc, V62_BLUFF_SHARE[sc], 0)).toBe(3);
      expect(v62TargetClass(sc, 0.99, V62_VALUE_MIX[sc][0] + 1e-9)).toBe(2);
      expect(v62TargetClass(sc, 0.99, 0.999)).toBe(1);
      expect(V62_VALUE_MIX[sc][0] + V62_VALUE_MIX[sc][1] + V62_VALUE_MIX[sc][2]).toBeCloseTo(1, 9);
    }
    // bigger wagers are bluffed less and carry more two pair plus
    expect(V62_BLUFF_SHARE[2]).toBeLessThan(V62_BLUFF_SHARE[0]);
    expect(V62_VALUE_MIX[2][0]).toBeGreaterThan(V62_VALUE_MIX[0][0]);
    // a value target never falls to air
    for (const t of [1, 2, 3] as const) expect(V62_FALLBACK[t]).not.toContain(0);
  });

  it('the stratum index excludes dead cards and keeps two pair on a dry board inside a band', () => {
    const hero = cards('AsKd');
    const index = buildV62StratumIndex([0.3, 1], board, hero, false);
    const tbl = buildV62StratumIndex(null, board, hero, false);
    const total = tbl[0].length + tbl[1].length + tbl[2].length + tbl[3].length;
    expect(total).toBe((45 * 44) / 2);
    expect(index[3].length).toBeGreaterThan(0);
    expect(index[3].length).toBeLessThan(tbl[3].length);
    // nothing in the index can hold a hero or board card
    const banded = index[0].length + index[1].length + index[2].length + index[3].length;
    expect(banded).toBeLessThan(total);
  });
});

describe('V62 equity shape (sampler)', () => {
  const read = (lastFrac: number, extra: Partial<OppPostflopRead> = {}): OppPostflopRead => ({
    aggrW: 0.25,
    checked: 0,
    streets: 3,
    lastFrac,
    lastStage: 'river',
    ...extra,
  });
  const eq = (hole: string, board: string, r: OppPostflopRead) =>
    simulateEquity(cards(hole), cards(board), 1, NLH, 4000, [[0.3, 1]], false, undefined, [r]);

  beforeEach(() => seedFastRandom(0x5eed62));

  it('top pair facing a large river wager is a bluff-catcher, not an 85% favourite', () => {
    const contact = eq('AsKd', 'Kh9h7c6s2h', read(0.75));
    const polar = eq('AsKd', 'Kh9h7c6s2h', read(0.75, { riverPolar: true }));
    expect(contact).toBeGreaterThan(0.7);
    expect(polar).toBeGreaterThan(0.25);
    expect(polar).toBeLessThan(0.5);
  });

  it('a smaller wager is less polar, a set still beats the range, a worse pair is behind it', () => {
    const small = eq('AsKd', 'Kh9h7c6s2h', read(0.33, { riverPolar: true }));
    const large = eq('AsKd', 'Kh9h7c6s2h', read(0.75, { riverPolar: true }));
    expect(small).toBeGreaterThan(large + 0.15);
    expect(eq('7h7d', 'Kc7s2d4h9s', read(0.75, { riverPolar: true }))).toBeGreaterThan(0.75);
    expect(eq('9h8d', 'Kc7s2d4h9s', read(0.75, { riverPolar: true }))).toBeLessThan(0.3);
    // a river raise is read as the largest class
    const raise = eq('AsKd', 'Kh9h7c6s2h', read(0.33, { raised: true, riverPolar: true }));
    expect(Math.abs(raise - large)).toBeLessThan(0.08);
  });

  it('does nothing before the river or without the river-polar mark', () => {
    seedFastRandom(1);
    const a = simulateEquity(cards('AsKd'), cards('Kh9h7c6s'), 1, NLH, 3000, [[0.3, 1]], false, undefined, [
      read(0.75, { riverPolar: true, lastStage: 'turn' }),
    ]);
    seedFastRandom(1);
    const b = simulateEquity(cards('AsKd'), cards('Kh9h7c6s'), 1, NLH, 3000, [[0.3, 1]], false, undefined, [
      read(0.75, { lastStage: 'turn' }),
    ]);
    expect(a).toBe(b);
  });
});

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
  history.push({ stage: 'river', seat: 1, userId: 'hero', action: 'check', amount: 0, timestamp: 5 });
  history.push({ stage: 'river', seat: 2, userId: 'villain', action: 'bet', amount: bet, timestamp: 6 });
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

/** The equity the V38 river verdict was handed (null when another branch
 * decided first), and the decision, with the given options. */
function verdict(s: ReturnType<typeof river>, opts: Record<string, unknown>) {
  const spy = vi.spyOn(EvEngine, 'riverCallVerdict');
  try {
    const decision = HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, {
      telemetry: true,
      ...opts,
    } as never);
    const equity = spy.mock.calls.length === 1 ? spy.mock.calls[0][0].equity : null;
    return { decision, equity };
  } finally {
    spy.mockRestore();
  }
}

describe('V62 in the decision: the river bettor is sampled polar', () => {
  beforeEach(() => {
    seedFastRandom(0x5eed62);
    HorseMind.reset();
    enableBrainTelemetry();
    drainFires();
  });

  it('top pair facing a three-quarter pot river bet is a bluff-catch read and folds; the old arm called', () => {
    const on = verdict(river('nlh', 'AsKd', 'Kh9h7c6s2h', 15), {});
    const onFires = fires();
    expect(onFires['v62_river_bettor_polarity']).toBe(1);
    expect(onFires['v38_river_fold']).toBe(1);
    expect(on.decision.action).toBe('fold');
    expect(on.equity).not.toBeNull();
    expect(on.equity!).toBeLessThan(0.45);
    seedFastRandom(0x5eed62);
    const off = verdict(river('nlh', 'AsKd', 'Kh9h7c6s2h', 15), {
      v62RiverBettorPolarity: false,
    });
    expect(fires()['v62_river_bettor_polarity']).toBeUndefined();
    expect(off.decision.action).toBe('call');
  });

  it('applies in tournaments and to a set alike (the model is the bettor range, not the hero hand)', () => {
    verdict(river('nlh', 'AsKd', 'Kh9h7c6s2h', 15, 'tournament'), {});
    expect(fires()['v62_river_bettor_polarity']).toBe(1);
    const set = verdict(river('nlh', '7h7d', 'Kc7s2d4h9s', 15), {});
    expect(fires()['v62_river_bettor_polarity']).toBe(1);
    expect(set.decision.action).not.toBe('fold');
  });

  it('Omaha, short deck and a measured over-bluffer keep the contact range', () => {
    const decide = (variant: string, hole: string, board: string) => {
      const s = river(variant, hole, board, 15);
      HorseLogic.decide(s.hero, s.gs as never, 'balanced', {}, { telemetry: true } as never);
      return fires()['v62_river_bettor_polarity'];
    };
    expect(decide('plo4', 'AsKd9c2s', 'Kh9h7c6s2h')).toBeUndefined();
    expect(decide('sixplus', 'AsKd', 'Kh9h7c6sTh')).toBeUndefined();
    // an over-bluffer: tableExploit callDownMod above 1
    const spy = vi.spyOn(HorseMind, 'tableExploit').mockReturnValue({
      bluffMod: 1,
      callDownMod: 1.3,
      valueThinMod: 1,
    } as never);
    try {
      expect(decide('nlh', 'AsKd', 'Kh9h7c6s2h')).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
