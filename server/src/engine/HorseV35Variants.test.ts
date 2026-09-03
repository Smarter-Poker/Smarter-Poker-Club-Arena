/**
 * V35 — the games are different games (2026-09-02, horse brain audit phase 2).
 *
 * Before this: every variant's preflop strength is mapped onto the hold'em
 * ladder by quantile, which made every variant open, defend and 3-bet at
 * HOLD'EM frequencies to the point (probe, 2026-09-02: PLO4/6/8, short deck
 * and pineapple all opened the button 41-43% and 3-bet 7-9%). Fixed limit had
 * no overlay at all. After the pineapple discard, hold'em solver cells were
 * answering pineapple hands. A pineapple flop was scored best-five-of-EIGHT.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import {
  variantPreflopShift,
  variantPostflopProfile,
  KNOWN_VARIANTS,
} from './HorseVariantProfile.js';
import {
  variantInfo,
  scoreBestTwoOfThree,
  scoreHoldem,
  simulateEquity,
  seedFastRandom,
} from './HorseEval.js';
import { HorseLogic } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { setGtoPostflop, _clearGtoPostflop, textureClass } from './GtoPostflop.js';
import { _clearGtoPostflopV31 } from './GtoPostflopV31.js';
import { enableBrainTelemetry, drainFires } from './BrainTelemetry.js';
import type { Card, CardRank, CardSuit } from '../types.js';

const SUITS: Record<string, CardSuit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function cards(text: string): Card[] {
  const out: Card[] = [];
  for (let i = 0; i + 1 < text.length; i += 2)
    out.push({ rank: text[i] as CardRank, suit: SUITS[text[i + 1]] });
  return out;
}

function ctx(o: Partial<PreflopCtx>): PreflopCtx {
  return {
    strength: 0.5,
    position: 'late',
    raiserPosition: null,
    raises: 0,
    limpers: 0,
    callers: 0,
    oppsLeft: 5,
    toCall: 2,
    currentBet: 2,
    pot: 3,
    bigBlind: 2,
    stack: 200,
    stackBB: 100,
    tightness: 1,
    bluffFreq: 0.17,
    aggression: 1,
    slowplayFreq: 0.1,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0,
    mode: 'cash',
    anteOrbitBB: 0,
    tableSize: 6,
    isButton: true,
    rand: () => 0.99,
    ...o,
  };
}

beforeEach(() => seedFastRandom(0x5eed35));

describe('V35 every variant has its own preflop width', () => {
  it('knows every dealt variant, and hold em is the zero', () => {
    for (const v of [
      'nlh',
      'pineapple',
      'short_deck',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'flh',
      'flo8',
    ]) {
      expect(KNOWN_VARIANTS).toContain(v);
    }
    expect(variantPreflopShift('nlh')).toEqual({
      open: 0,
      threeBet: 0,
      fourBet: 0,
      coldCall: 0,
      bbDefend: 0,
    });
    expect(variantPreflopShift(undefined)).toEqual(variantPreflopShift('nlh'));
  });

  it('PLO opens wider than hold em and 3-bets narrower; six cards more so than four', () => {
    const p4 = variantPreflopShift('plo4');
    const p6 = variantPreflopShift('plo6');
    expect(p4.open).toBeLessThan(0);
    expect(p6.open).toBeLessThan(p4.open);
    expect(p4.threeBet).toBeGreaterThan(0);
    expect(p6.threeBet).toBeGreaterThan(p4.threeBet);
    expect(p4.bbDefend).toBeLessThan(0);
  });

  it('a PLO button opens a hand a hold em button folds', () => {
    const hand = ctx({ strength: 0.25, isOmaha: true, isPotLimit: true });
    expect(decidePreflopV7({ ...hand, variantShift: variantPreflopShift('nlh') }).a).toBe('fold');
    expect(decidePreflopV7({ ...hand, variantShift: variantPreflopShift('plo4') }).a).toBe(
      'raiseTo'
    );
  });

  it('a PLO hand at the hold em 3-bet margin flats instead', () => {
    const face = ctx({
      strength: 0.75,
      position: 'late',
      raises: 1,
      raiserPosition: 'late',
      oppsLeft: 2,
      toCall: 5,
      currentBet: 5,
      pot: 8,
      rand: () => 0.99,
    });
    // THREEBET_VS.late is 0.74: a hold em 0.75 3-bets; PLO's +0.03 makes it a call.
    expect(decidePreflopV7({ ...face, variantShift: variantPreflopShift('nlh') }).a).toBe(
      'raiseTo'
    );
    expect(
      decidePreflopV7({
        ...face,
        isOmaha: true,
        isPotLimit: true,
        variantShift: variantPreflopShift('plo4'),
      }).a
    ).toBe('call');
  });

  it('a short deck big blind defends a steal that a hold em big blind folds', () => {
    const face = ctx({
      strength: 0.18,
      position: 'bb',
      raises: 1,
      raiserPosition: 'late',
      oppsLeft: 1,
      toCall: 3,
      currentBet: 5,
      pot: 8,
      isButton: false,
    });
    expect(decidePreflopV7({ ...face, variantShift: variantPreflopShift('nlh') }).a).toBe('fold');
    expect(decidePreflopV7({ ...face, variantShift: variantPreflopShift('short_deck') }).a).toBe(
      'call'
    );
  });

  it('fixed limit opens and defends widest and bluffs least', () => {
    expect(variantPreflopShift('flh').bbDefend).toBeLessThan(variantPreflopShift('plo4').bbDefend);
    expect(variantPostflopProfile('flh').bluffMul).toBeLessThan(
      variantPostflopProfile('plo6').bluffMul
    );
    expect(variantPostflopProfile('flh').checkRaiseMul).toBeGreaterThan(1);
    expect(variantPostflopProfile('flh').callRespect).toBeLessThan(0);
    expect(variantInfo('flh').isFixedLimit).toBe(true);
    expect(variantInfo('flo8').isFixedLimit).toBe(true);
    expect(variantInfo('plo4').isFixedLimit).toBe(false);
  });

  it('bluff volume falls with every extra Omaha card', () => {
    const b4 = variantPostflopProfile('plo4').bluffMul;
    const b5 = variantPostflopProfile('plo5').bluffMul;
    const b6 = variantPostflopProfile('plo6').bluffMul;
    expect(b4).toBeLessThan(1);
    expect(b5).toBeLessThan(b4);
    expect(b6).toBeLessThan(b5);
  });
});

describe('V35 cash and tournaments size a 3-bet differently', () => {
  const threeBet = (mode: 'cash' | 'tournament', stackBB: number) => {
    const d = decidePreflopV7(
      ctx({
        strength: 0.95,
        position: 'late',
        raises: 1,
        raiserPosition: 'middle',
        oppsLeft: 2,
        toCall: 5,
        currentBet: 5,
        pot: 8,
        stack: stackBB * 2,
        stackBB,
        mode,
        slowplayFreq: 0,
        rand: () => 0.5,
      })
    );
    expect(d.a).toBe('raiseTo');
    return d.to! / 5;
  };
  it('a 30bb tournament 3-bet is half a unit smaller than the cash one', () => {
    expect(threeBet('cash', 30) - threeBet('tournament', 30)).toBeCloseTo(0.5, 6);
  });
  it('deep tournament stacks keep the cash size', () => {
    expect(threeBet('cash', 80)).toBeCloseTo(threeBet('tournament', 80), 6);
  });
});

describe('V35 pineapple: three cards, two play', () => {
  it('the best two-of-three never beats the eight-card read, and loses to it when the third card was doing the work', () => {
    const board = cards('8c9d2h');
    const hole = cards('5h6d7s'); // all three make a 5-9 straight; any two are a draw
    const all = hole.concat(board);
    const eight = scoreHoldem(all, all.length, false);
    const two = scoreBestTwoOfThree(hole, board, false);
    expect(two).toBeLessThan(eight);
    expect(Math.floor(eight / 0x100000)).toBe(5); // the eight-card read saw a straight
    expect(Math.floor(two / 0x100000)).toBeLessThan(5); // the honest read sees a draw
  });

  it('flop equity for a three-card straight is a draw, not a lock', () => {
    const eq = simulateEquity(cards('5h6d7s'), cards('8c9d2h'), 1, variantInfo('pineapple'), 1500);
    expect(eq).toBeGreaterThan(0.25);
    expect(eq).toBeLessThan(0.75);
  });
});

describe('V35 hold em solver cells answer hold em hands only', () => {
  const BOARD = cards('Ks9d7c');
  function state(variant: string) {
    const players = [
      {
        seat: 1,
        user_id: 'villain',
        username: 'v',
        stack: 8000,
        bet: 0,
        totalInvested: 250,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        cards: [],
      },
      {
        seat: 2,
        user_id: 'hero',
        username: 'h',
        stack: 8000,
        bet: 0,
        totalInvested: 250,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        cards: cards('KhQh'),
      },
    ];
    return {
      hero: players[1],
      gs: {
        players,
        communityCards: BOARD,
        pot: 500,
        currentBet: 0,
        minRaise: 100,
        stage: 'flop',
        gameVariant: variant,
        gameMode: 'cash',
        bigBlind: 100,
        dealerSeat: 2,
        actionHistory: [
          { stage: 'preflop', seat: 2, userId: 'hero', action: 'raise', amount: 250, timestamp: 1 },
          {
            stage: 'preflop',
            seat: 1,
            userId: 'villain',
            action: 'call',
            amount: 150,
            timestamp: 2,
          },
          { stage: 'flop', seat: 1, userId: 'villain', action: 'check', amount: 0, timestamp: 3 },
        ],
      },
    };
  }
  beforeEach(() => {
    _clearGtoPostflop();
    _clearGtoPostflopV31();
    HorseMind.reset();
    setGtoPostflop([
      {
        street: 'flop',
        game_family: 'cash',
        position: 'SB', // heads-up the dealer is the SB
        depth_bucket: 80,
        texture_class: textureClass(BOARD)!,
        facing: 'open',
        hand_matrix: { KQs: { bet_big: 1 } },
      },
    ]);
    enableBrainTelemetry();
    drainFires();
  });
  afterEach(() => {
    _clearGtoPostflop();
    _clearGtoPostflopV31();
    HorseMind.reset();
  });
  const fires = () => Object.fromEntries(drainFires().map((r) => [r.feature, r.fires]));

  it('a hold em hand consults the cell', () => {
    const s = state('nlh');
    HorseLogic.decide(
      s.hero as never,
      s.gs as never,
      'balanced',
      {},
      { telemetry: true, mind: false }
    );
    expect(fires()['v29_gto_flop_open'] ?? 0).toBe(1);
  });
  it('a pineapple hand after the discard does not, nor does fixed limit', () => {
    for (const v of ['pineapple', 'flh']) {
      const s = state(v);
      HorseLogic.decide(
        s.hero as never,
        s.gs as never,
        'balanced',
        {},
        { telemetry: true, mind: false }
      );
      expect(fires()['v29_gto_flop_open'] ?? 0).toBe(0);
    }
  });
});
