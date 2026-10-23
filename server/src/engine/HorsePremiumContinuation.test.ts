import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { decidePreflopV7, type PreflopCtx } from './HorsePreflop.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom } from './HorseEval.js';
import { barrelContinuationValue, evaluateSpot } from './HorseEvEngine.js';
import { HandController } from './HandController.js';
import { Deck } from './PokerEngine.js';
import * as EvEngine from './HorseEvEngine.js';
import { freshExploitCounters } from './HorseOpponentExploit.js';
import { controllerDecisionState } from './remainingVariants/RemainingVariantControllerSpots.test-support.js';
import type { Card, HandConfig, HorseStyle, SeatPlayer } from '../types.js';
const SUITS: Record<string, string> = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const cards = (text: string): Card[] =>
  text.match(/../g)!.map((x) => ({ rank: x[0], suit: SUITS[x[1]] }) as Card);
const variants = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'] as const;
const styles: HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];
const holding = (variant: string, base: string) =>
  cards(
    variant === 'nlh'
      ? base.startsWith('K')
        ? 'KsKh'
        : 'AsAh'
      : base + (variant === 'plo5' ? '9d' : variant === 'plo6' ? '9d8c' : '')
  );
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});

describe('suited premiums squeeze through the real controller menu', () => {
  for (const variant of variants)
    for (const base of ['AsAh7s2c', 'AsAh7s2h', 'KsKhQsJh'])
      for (const mode of ['cash', 'tournament'] as const) {
        it(`${variant} ${mode} ${base}: value re-raises a single open and four callers`, () => {
          for (const style of styles)
            for (let seed = 0; seed < 8; seed++) {
              const hole = holding(variant, base);
              const n = hole.length;
              const shuffle = vi.spyOn(Deck.prototype, 'shuffle').mockImplementation(function (
                this: Deck
              ) {
                const deck = (this as unknown as { cards: Card[] }).cards;
                const rest = deck.filter(
                  (c) => !hole.some((h) => h.rank === c.rank && h.suit === c.suit)
                );
                deck.splice(0, deck.length, ...rest.slice(0, n), ...hole, ...rest.slice(n));
              });
              const config: HandConfig = {
                tableId: '10000000-0000-4000-8000-000000000001',
                handNumber: 1,
                gameVariant: variant,
                smallBlind: 1,
                bigBlind: 2,
                ante: 0,
                isTournament: mode === 'tournament',
                rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
              };
              const players = Array.from(
                { length: 6 },
                (_, i) =>
                  ({
                    seat: i + 1,
                    user_id: `p${i + 1}`,
                    username: `P${i + 1}`,
                    totalInvested: 0,
                    stack: 202,
                    bet: 0,
                    cards: [],
                    is_folded: false,
                    is_all_in: false,
                    is_sitting_out: false,
                  }) as SeatPlayer
              );
              const c = new HandController(config, players, 6);
              c.start();
              shuffle.mockRestore();
              expect(c.performAction(3, 'raise', 7)).toBe(true);
              for (const seat of [4, 5, 6, 1]) expect(c.performAction(seat, 'call')).toBe(true);
              const spot = controllerDecisionState(c, variant as never, mode, config)!;
              expect(spot.hero.seat).toBe(2);
              expect(spot.hero.cards).toEqual(hole);
              seedFastRandom(100 + seed);
              const d = HorseLogic.decide(spot.hero, spot.state, style, {}, { telemetry: false });
              expect(['raise', 'all_in']).toContain(d.action);
              expect(c.performAction(spot.hero.seat, d.action, d.amount)).toBe(true);
            }
        });
      }
});

describe('the remainder after a preflop raise is priced on the flop', () => {
  for (const variant of variants)
    it(`${variant}: dry flop, 150 invested and 35 behind`, () => {
      const hero = {
        seat: 2,
        user_id: 'hero',
        stack: 35,
        bet: 0,
        is_folded: false,
        cards: holding(variant, 'AsAh7s2h'),
      } as SeatPlayer;
      const gs = {
        players: [
          { seat: 1, user_id: 'v1', stack: 400, bet: 0, is_folded: false, cards: [] },
          hero,
        ],
        communityCards: cards('Qc6d3h'),
        pot: 303,
        currentBet: 0,
        minRaise: 2,
        lastRaise: 2,
        stage: 'flop',
        gameVariant: variant,
        bigBlind: 2,
        smallBlind: 1,
        dealerSeat: 2,
        actionHistory: [
          { stage: 'preflop', seat: 1, userId: 'v1', action: 'raise', amount: 50 },
          { stage: 'preflop', seat: 2, userId: 'hero', action: 'raise', amount: 150 },
          { stage: 'preflop', seat: 1, userId: 'v1', action: 'call', amount: 150 },
          { stage: 'flop', seat: 1, userId: 'v1', action: 'check', amount: 0 },
        ],
      } as unknown as HorseGameStateV2;
      for (const style of styles)
        for (let seed = 0; seed < 8; seed++) {
          seedFastRandom(100 + seed);
          expect(HorseLogic.decide(hero, gs, style, {}, { telemetry: false }).action).toBe(
            'all_in'
          );
        }
    });
  it('terminal calls and jams realize full equity; a pot-limit ceiling still applies', () => {
    const v = evaluateSpot({
      equity: 0.4,
      pot: 300,
      toCall: 0,
      stack: 35,
      effectiveStack: 35,
      street: 'flop',
      inPosition: false,
      opponents: 1,
      realization: 0.75,
      minBet: 2,
      maxBet: 300,
      sizes: [],
      initiative: true,
      rand: () => 0,
    });
    expect(v.best.kind).toBe('bet');
    expect(v.pick.kind).toBe('bet');
    const call = evaluateSpot({
      equity: 0.3,
      pot: 150,
      toCall: 50,
      stack: 50,
      effectiveStack: 50,
      street: 'flop',
      inPosition: false,
      opponents: 1,
      realization: 0.75,
      minBet: 2,
      maxBet: 0,
      sizes: [],
      rand: () => 0,
    });
    expect(call.candidates.find((c) => c.kind === 'call')!.ev).toBeCloseTo(10);
  });
});

describe('call-side barrel budget, independently derived closed forms', () => {
  const value = (equity: number, q: number, stack = 1000, streets = 1) =>
    barrelContinuationValue({
      equity,
      pot: 150,
      toCall: 50,
      stack,
      continuation: { betProbability: q, betFraction: 1, opponentStack: 1000, streets },
    });
  it('a 30% hand clears today’s price, but loses paying it to fold to a certain pot barrel', () => {
    expect(value(0.3, 0)).toBeCloseTo(10);
    expect(value(0.3, 1)).toBeCloseTo(-50);
    expect(value(0.3, 0.5)).toBeCloseTo(-20);
    expect(value(0.3, 1, 1000, 2)).toBeCloseTo(-50);
  });
  it('a strong bluff-catcher funds the next call instead of giving up', () =>
    expect(value(0.6, 1)).toBeCloseTo(110));
  it('the remaining stack caps the future cost; an all-in has no later barrel', () => {
    expect(value(0.3, 1, 50)).toBeCloseTo(10);
    expect(value(0.3, 1, 70)).toBeCloseTo(2);
  });
  it('declining a later bet can still make the current call profitable when checks are frequent', () => {
    expect(value(0.3, 0.1)).toBeCloseTo(4);
  });
});

describe('opponent barrel read reaches the real call decision', () => {
  for (const variant of variants)
    it(`${variant}: funds the next street from the current bettor’s own postflop read`, () => {
      const opp = '10000000-0000-4000-8000-000000000009';
      const counters = {
        ...freshExploitCounters(),
        hands: 40,
        vpip: 40,
        pfr: 32,
        betCheckedToOpp: 40,
        betCheckedTo: 32,
      };
      HorseMind.importDurableOpponentProfiles([
        {
          user_id: opp,
          variant,
          mode: 'cash',
          size: 'hu',
          observed_hands: 40,
          initialized: true,
          counters,
        },
      ]);
      const hero = {
        seat: 2,
        user_id: 'hero',
        username: 'Hero',
        totalInvested: 17,
        stack: 1000,
        bet: 0,
        is_folded: false,
        cards: cards(
          variant === 'nlh'
            ? 'QhQd'
            : 'QhQd9c7s' + (variant === 'plo5' ? 'Jc' : variant === 'plo6' ? 'JcTh' : '')
        ),
      } as SeatPlayer;
      const gs = {
        players: [{ seat: 1, user_id: opp, stack: 995, bet: 5, is_folded: false, cards: [] }, hero],
        communityCards: cards('Kc8d2h4s'),
        pot: 100,
        currentBet: 5,
        minRaise: 5,
        lastRaise: 5,
        stage: 'turn',
        gameVariant: variant,
        bigBlind: 2,
        smallBlind: 1,
        dealerSeat: 2,
        actionHistory: [
          { stage: 'preflop', seat: 1, userId: opp, action: 'raise', amount: 7 },
          { stage: 'preflop', seat: 2, userId: 'hero', action: 'call', amount: 7 },
          { stage: 'flop', seat: 1, userId: opp, action: 'bet', amount: 10 },
          { stage: 'flop', seat: 2, userId: 'hero', action: 'call', amount: 10 },
          { stage: 'turn', seat: 1, userId: opp, action: 'bet', amount: 5 },
        ],
      } as unknown as HorseGameStateV2;
      const spy = vi.spyOn(EvEngine, 'evaluateSpot');
      seedFastRandom(10);
      HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: false });
      const plan = spy.mock.calls.find(([s]) => s.continuation)?.[0].continuation;
      expect(plan).toBeDefined();
      expect(plan!.streets).toBe(1);
      expect(plan!.opponentStack).toBe(995);
      expect(plan!.betProbability).toBeGreaterThan(0.6);
      spy.mockClear();
      const drawingHero = {
        ...hero,
        cards: cards(
          variant === 'nlh'
            ? 'QhQc'
            : 'QhQc9c7s' + (variant === 'plo5' ? 'Jc' : variant === 'plo6' ? 'JcTh' : '')
        ),
      };
      const drawingState = {
        ...gs,
        communityCards: cards(variant === 'nlh' ? 'Kc8c2c4s' : 'Kc8c2h4s'),
        players: [gs.players[0], drawingHero],
      };
      seedFastRandom(10);
      HorseLogic.decide(drawingHero, drawingState, 'balanced', {}, { telemetry: false });
      expect(spy.mock.calls.some(([s]) => s.continuation)).toBe(false);
      spy.mockClear();
      HorseMind.reset();
      seedFastRandom(10);
      HorseLogic.decide(hero, gs, 'balanced', {}, { telemetry: false });
      expect(spy.mock.calls.some(([s]) => s.continuation)).toBe(false);
    });
});

describe('barrel budgeting replaces generic realization rather than charging it twice', () => {
  it('declines today’s apparently cheap call when the observed later barrel makes the line lose', () => {
    const spot = {
      equity: 0.35,
      pot: 150,
      toCall: 50,
      stack: 1000,
      effectiveStack: 1000,
      street: 'turn' as const,
      inPosition: false,
      opponents: 1,
      realization: 0.85,
      minBet: 2,
      maxBet: 0,
      sizes: [],
      rand: () => 0,
    };
    const current = evaluateSpot(spot).candidates.find((c) => c.kind === 'call')!;
    const planned = evaluateSpot({
      ...spot,
      continuation: { betProbability: 0.4, betFraction: 1, opponentStack: 1000, streets: 1 },
    }).candidates.find((c) => c.kind === 'call')!;
    expect(current.ev).toBeCloseTo(9.5);
    expect(planned.ev).toBeCloseTo(-4);
  });
  it('a check-through future realizes equity without a second discount', () => {
    const v = evaluateSpot({
      equity: 0.3,
      pot: 150,
      toCall: 50,
      stack: 1000,
      effectiveStack: 1000,
      street: 'turn',
      inPosition: false,
      opponents: 1,
      realization: 0.85,
      minBet: 2,
      maxBet: 0,
      sizes: [],
      rand: () => 0,
      continuation: { betProbability: 0, betFraction: 1, opponentStack: 1000, streets: 1 },
    });
    expect(v.candidates.find((c) => c.kind === 'call')!.ev).toBeCloseTo(10);
  });
});

describe('preflop commitment sizing respects the actual pot ceiling', () => {
  const ctx: PreflopCtx = {
    strength: 1,
    position: 'late',
    raiserPosition: 'middle',
    raises: 1,
    limpers: 0,
    callers: 0,
    oppsLeft: 1,
    toCall: 50,
    currentBet: 50,
    pot: 50,
    bigBlind: 2,
    stack: 185,
    stackBB: 92.5,
    tightness: 1,
    bluffFreq: 0,
    aggression: 1,
    slowplayFreq: 0,
    sizingMultiplier: 1,
    isOmaha: false,
    isPotLimit: false,
    riskAdd: 0,
    mode: 'cash',
    tableSize: 6,
    rand: () => 0,
  };
  it('uses the legal full stack rather than raising 150 and saving 35 in no limit', () => {
    expect(decidePreflopV7(ctx)).toEqual({ a: 'jam' });
  });
  it('retains the 35 when pot limit permits only 150; the flop must price that remainder', () => {
    expect(decidePreflopV7({ ...ctx, isOmaha: true, isPotLimit: true, omahaAA: true })).toEqual({
      a: 'raiseTo',
      to: 150,
    });
  });
});
