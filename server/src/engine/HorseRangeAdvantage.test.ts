import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import * as Continuation from './HorseContinuation.js';
import * as EvEngine from './HorseEvEngine.js';
import type { SeatPlayer } from '../types.js';
import {
  estimateRangeAdvantage,
  saveFastRandom,
  seedFastRandom,
  variantInfo,
} from './HorseEval.js';
import type { Card } from '../types.js';
const suits: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const cards = (s: string): Card[] =>
  s.match(/../g)!.map((c) => ({ rank: c[0], suit: suits[c[1]] }) as Card);
const variants = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'];
describe('public range advantage across Holdem and Omaha', () => {
  for (const variant of variants) {
    it(`${variant} prices the ranges and preserves the decision random stream`, () => {
      seedFastRandom(6789);
      const before = saveFastRandom();
      const result = estimateRangeAdvantage(
        cards('AsKh7d'),
        [0.86, 1],
        [0, 0.4],
        variantInfo(variant)
      );
      expect(result).not.toBeNull();
      expect(result!.samples).toBeGreaterThanOrEqual(96);
      expect(result!.advantage).toBe(true);
      expect(result!.equity).toBeGreaterThan(0.5);
      expect(saveFastRandom()).toBe(before);
      result!.equity = 0;
      const cached = estimateRangeAdvantage(
        cards('AsKh7d'),
        [0.86, 1],
        [0, 0.4],
        variantInfo(variant)
      );
      expect(cached!.equity).toBeGreaterThan(0.5);
      expect(saveFastRandom()).toBe(before);
    });
  }
  for (const variant of variants)
    it(`${variant} does not infer advantage from a high card when the other range is stronger`, () => {
      const result = estimateRangeAdvantage(
        cards('AsKh7d'),
        [0, 0.4],
        [0.86, 1],
        variantInfo(variant)
      )!;
      expect(result.advantage).toBe(false);
      expect(result.disadvantage).toBe(true);
    });
  it('does not give an Omaha preflop raiser an automatic edge on connected low boards', () => {
    const r = estimateRangeAdvantage(cards('7s6d5c'), [0.86, 1], [0, 0.4], variantInfo('plo4'))!;
    expect(r.advantage).toBe(false);
    expect(r.disadvantage).toBe(true);
  });
  it('recognizes an exact board-only Holdem tie independently of range sampling', () => {
    const r = estimateRangeAdvantage(cards('AsKsQsJsTs'), [0, 1], [0, 1], variantInfo('nlh'))!;
    expect(r.equity).toBe(0.5);
    expect(r.standardError).toBe(0);
    expect(r.advantage).toBe(false);
    expect(r.disadvantage).toBe(false);
  });
  it('rejects invalid bands, duplicate cards and unsupported rules', () => {
    expect(estimateRangeAdvantage(cards('AsAs7d'), [0, 1], [0, 1], variantInfo('plo5'))).toBeNull();
    expect(estimateRangeAdvantage(cards('AsKh7d'), [1, 0], [0, 1], variantInfo('nlh'))).toBeNull();
    expect(estimateRangeAdvantage(cards('AsKh'), [0, 1], [0, 1], variantInfo('nlh'))).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
describe('the live reference consumes public range advantage', () => {
  for (const variant of variants)
    it(`${variant} sends both public ranges to the estimator`, () => {
      const hero = {
        seat: 2,
        user_id: 'hero',
        username: 'Hero',
        totalInvested: 7,
        stack: 1000,
        bet: 0,
        is_folded: false,
        cards: cards(
          variant === 'nlh'
            ? 'QhQd'
            : '3s4cThJd' + (variant === 'plo5' ? '9h' : variant === 'plo6' ? '9h6d' : '')
        ),
      } as SeatPlayer;
      const gs = {
        players: [
          { seat: 1, user_id: 'opponent', stack: 1000, bet: 0, is_folded: false, cards: [] },
          hero,
        ],
        communityCards: cards('Kc8d2h'),
        pot: 100,
        currentBet: 0,
        minRaise: 2,
        lastRaise: 2,
        stage: 'flop',
        gameVariant: variant,
        bigBlind: 2,
        smallBlind: 1,
        dealerSeat: 2,
        actionHistory: [
          { stage: 'preflop', seat: 2, userId: 'hero', action: 'raise', amount: 7 },
          { stage: 'preflop', seat: 1, userId: 'opponent', action: 'call', amount: 7 },
          { stage: 'flop', seat: 1, userId: 'opponent', action: 'check', amount: 0 },
        ],
      } as unknown as HorseGameStateV2;
      const range = vi.spyOn(Continuation, 'rangeAdvantageFor');
      const ev = vi.spyOn(EvEngine, 'evaluateSpot');
      seedFastRandom(10);
      HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: false });
      expect(range).toHaveBeenCalledTimes(1);
      expect(range.mock.calls[0][0]).toEqual(gs.communityCards);
      expect(range.mock.calls[0]).toHaveLength(5);
      expect(range.mock.calls[0][4]).toBeUndefined();
      expect(range.mock.calls[0][1]).toHaveLength(2);
      expect(range.mock.calls[0][2]).toHaveLength(2);
      const result = range.mock.results[0].value;
      expect(result?.samples).toBeGreaterThanOrEqual(96);
      if (variant !== 'nlh') {
        expect(ev).toHaveBeenCalled();
        expect(ev.mock.calls.at(-1)![0].initiative).toBe(!result!.disadvantage);
      }
    });
});

describe('turn runout reads reach the actual Omaha continuation decision', () => {
  for (const variant of ['plo4', 'plo5', 'plo6', 'plo8'])
    it(`${variant} stops automatic initiative on an opposing range runout`, () => {
      const hero = {
        seat: 2,
        user_id: 'hero',
        username: 'Hero',
        totalInvested: 7,
        stack: 1000,
        bet: 0,
        is_folded: false,
        cards: cards('3s4cThJd' + (variant === 'plo5' ? '9h' : variant === 'plo6' ? '9h6d' : '')),
      } as SeatPlayer;
      const gs = {
        players: [
          { seat: 1, user_id: 'opponent', stack: 1000, bet: 0, is_folded: false, cards: [] },
          hero,
        ],
        communityCards: cards('Kc8d2h2c'),
        pot: 100,
        currentBet: 0,
        minRaise: 2,
        lastRaise: 2,
        stage: 'turn',
        gameVariant: variant,
        bigBlind: 2,
        smallBlind: 1,
        dealerSeat: 2,
        actionHistory: [
          { stage: 'preflop', seat: 2, userId: 'hero', action: 'raise', amount: 7 },
          { stage: 'preflop', seat: 1, userId: 'opponent', action: 'call', amount: 7 },
          { stage: 'flop', seat: 1, userId: 'opponent', action: 'check', amount: 0 },
          { stage: 'flop', seat: 2, userId: 'hero', action: 'check', amount: 0 },
          { stage: 'turn', seat: 1, userId: 'opponent', action: 'check', amount: 0 },
        ],
      } as unknown as HorseGameStateV2;
      const range = vi.spyOn(Continuation, 'rangeAdvantageFor').mockReturnValue({
        equity: 0.8,
        standardError: 0.01,
        samples: 128,
        advantage: true,
        disadvantage: false,
        madeRangeChange: {
          samples: 128,
          previousShare: 0.8,
          currentShare: 0.5,
          madeShareDelta: -0.3,
          deltaStandardError: 0.02,
          improves: false,
          worsens: true,
          heroNutMass: 0,
          opponentNutMass: 0,
          nutMassDelta: 0,
          nutDeltaStandardError: 0,
          nutAdvantage: false,
          nutDisadvantage: false,
        },
      });
      const ev = vi.spyOn(EvEngine, 'evaluateSpot');
      seedFastRandom(10);
      HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: false });
      expect(range).toHaveBeenCalledWith(
        gs.communityCards,
        expect.any(Array),
        expect.any(Array),
        expect.any(Object),
        { previousBoard: cards('Kc8d2h') }
      );
      expect(ev).toHaveBeenCalled();
      expect(ev.mock.calls.at(-1)![0].initiative).toBe(false);
    });
});
