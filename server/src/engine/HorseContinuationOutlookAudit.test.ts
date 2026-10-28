import { acceptedContinuationOutlook } from '../benchmark/FeatureAblationWorker.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic, type HorseDecideOpts } from './HorseLogic.js';
import { HorseMind } from './HorseMind.js';
import { seedFastRandom, saveFastRandom } from './HorseEval.js';
import type { Card, ActionRecord, SeatPlayer } from '../types.js';
const c = (s: string): Card => ({
  rank: s[0] as Card['rank'],
  suit: ({ c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const)[s[1] as 'c'],
});
function fixture(variant = 'nlh') {
  const hist: ActionRecord[] = [
    { seat: 2, userId: 'hero', action: 'raise', amount: 6, timestamp: 900001, stage: 'preflop' },
    { seat: 5, userId: 'villain', action: 'call', amount: 6, timestamp: 900002, stage: 'preflop' },
    { seat: 2, userId: 'hero', action: 'bet', amount: 4, timestamp: 900003, stage: 'flop' },
    { seat: 5, userId: 'villain', action: 'call', amount: 4, timestamp: 900004, stage: 'flop' },
    { seat: 5, userId: 'villain', action: 'check', amount: 0, timestamp: 900005, stage: 'turn' },
  ];
  const count = variant === 'nlh' ? 2 : Number(variant.slice(3));
  const hero: SeatPlayer = {
    seat: 2,
    user_id: 'hero',
    username: 'Horse',
    stack: 200,
    bet: 0,
    totalInvested: 10,
    cards: ['9c', '8c', 'Ah', 'Qh', 'Td', 'Js'].slice(0, count).map(c),
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  };
  const villain: SeatPlayer = { ...hero, seat: 5, user_id: 'villain', cards: [] };
  const gs = {
    players: [hero, villain],
    communityCards: ['Kd', '7s', '2c', '5h'].map(c),
    pot: 21,
    currentBet: 0,
    minRaise: 2,
    stage: 'turn' as const,
    gameVariant: variant,
    bigBlind: 2,
    dealerSeat: 2,
    actionHistory: hist,
  };
  return { hero, gs, key: HorseMind.handKeyOf(hist)! };
}
afterEach(() => {
  vi.restoreAllMocks();
  HorseMind.reset();
});
const stable = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (key, value) =>
      key === 'latencyMs' || key === 'elapsedMs' ? undefined : value
    )
  );
function decide(flag: boolean | undefined, variant = 'nlh', seed = 1, extra: HorseDecideOpts = {}) {
  HorseMind.reset();
  seedFastRandom(seed);
  const f = fixture(variant);
  HorseMind.notePlan(f.key, 'hero', true);
  const captured = HorseMind.captureDecisionEffects(() =>
    HorseLogic.decide(
      f.hero,
      f.gs as never,
      'balanced',
      {},
      { telemetry: false, barrelContinuationOutlook: flag, ...extra }
    )
  );
  return { ...f, ...captured, rng: saveFastRandom() };
}
describe('a planned turn barrel retains its private river outlook', () => {
  it('repairs the reproduced bet10 missing outlook without changing the turn action or RNG', () => {
    const before = decide(false);
    const after = decide(true);
    expect(before.value).toMatchObject({ action: 'bet', amount: 10 });
    expect(stable(after.value)).toEqual(stable(before.value));
    expect(after.rng).toBe(before.rng);
    expect(before.effects.map((e) => e.type)).toEqual(['raise_plan']);
    expect(after.effects.filter((e) => e.type !== 'outlook')).toEqual(before.effects);
    const outlook = after.effects.find((e) => e.type === 'outlook');
    expect(outlook).toMatchObject({
      type: 'outlook',
      handKey: after.key,
      userId: 'hero',
      street: 'turn',
      good: expect.arrayContaining(['6h']),
    });
    expect(after.effects.some((e) => e.type === 'plan')).toBe(false);
    const request = {
      player: after.hero,
      gameState: after.gs,
      opts: { barrelContinuationOutlook: true },
    } as Parameters<typeof acceptedContinuationOutlook>[0];
    expect(
      acceptedContinuationOutlook(
        request,
        after.effects,
        'COMMIT_DECISION_EFFECTS',
        'applied_volatile'
      )
    ).toBe(true);
    expect(
      acceptedContinuationOutlook(
        request,
        before.effects,
        'COMMIT_DECISION_EFFECTS',
        'applied_volatile'
      )
    ).toBe(false);
    expect(
      acceptedContinuationOutlook(request, after.effects, 'RETIRE_DECISION_EFFECTS', 'retired')
    ).toBe(false);
    expect(
      acceptedContinuationOutlook(
        { ...request, opts: { barrelContinuationOutlook: false } },
        after.effects,
        'COMMIT_DECISION_EFFECTS',
        'applied_volatile'
      )
    ).toBe(false);
    expect(
      acceptedContinuationOutlook(
        request,
        [
          ...after.effects,
          { type: 'plan', handKey: after.key, userId: 'hero', barrelIntent: true },
        ],
        'COMMIT_DECISION_EFFECTS',
        'applied_volatile'
      )
    ).toBe(false);
    expect(HorseMind.getPlan(after.key, 'hero')).toBe(true);
    expect(HorseMind.outlookOf(after.key, 'hero', 'turn', '6h')).toBeUndefined();
    HorseMind.applyDecisionEffects(after.effects);
    expect(HorseMind.outlookOf(after.key, 'hero', 'turn', '6h')).toBe('good');
    expect(HorseMind.outlookOf(after.key, 'villain', 'turn', '6h')).toBeUndefined();
    expect(HorseMind.outlookOf('other-hand', 'hero', 'turn', '6h')).toBeUndefined();
    const river = {
      ...after.gs,
      stage: 'river',
      communityCards: [...after.gs.communityCards, c('6h')],
      actionHistory: [
        ...after.gs.actionHistory,
        { seat: 2, userId: 'hero', action: 'bet', amount: 10, timestamp: 900006, stage: 'turn' },
        {
          seat: 5,
          userId: 'villain',
          action: 'call',
          amount: 10,
          timestamp: 900007,
          stage: 'turn',
        },
        {
          seat: 5,
          userId: 'villain',
          action: 'check',
          amount: 0,
          timestamp: 900008,
          stage: 'river',
        },
      ],
      pot: 41,
    };
    // The real next decision reads the turn entry; no opponent cards are supplied.
    const spy = vi.spyOn(HorseMind, 'outlookOf');
    HorseLogic.decide(
      after.hero,
      river as never,
      'balanced',
      {},
      { telemetry: false, barrelContinuationOutlook: true }
    );
    expect(spy).toHaveBeenCalledWith(after.key, 'hero', 'turn', '6h');
  });
  it.each(['nlh', 'plo4', 'plo5', 'plo6'])(
    'preserves every turn decision and RNG across the fixed %s control card',
    (variant) => {
      let repaired = 0;
      for (let seed = 1; seed <= 32; seed++) {
        const off = decide(false, variant, seed);
        const omitted = decide(undefined, variant, seed);
        const on = decide(true, variant, seed);
        expect(stable(omitted.value)).toEqual(stable(off.value));
        expect(omitted.effects).toEqual(off.effects);
        expect(omitted.rng).toBe(off.rng);
        expect(stable(on.value)).toEqual(stable(off.value));
        expect(on.rng).toBe(off.rng);
        if (on.effects.length > off.effects.length) {
          repaired++;
          expect(on.effects.filter((e) => e.type !== 'outlook')).toEqual(off.effects);
        }
      }
      expect(repaired).toBeGreaterThan(0);
    }
  );
  it('does not revive plans when the mind or barrel owner is disabled', () => {
    for (const extra of [{ mind: false }, { v7Barrels: false }]) {
      const off = decide(false, 'nlh', 1, extra);
      const on = decide(true, 'nlh', 1, extra);
      expect(stable(on.value)).toEqual(stable(off.value));
      expect(on.effects).toEqual(off.effects);
      expect(on.rng).toBe(off.rng);
    }
  });
});
