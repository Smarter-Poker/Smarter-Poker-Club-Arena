import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseMind } from './HorseMind.js';
import { horseMindHandIdentity } from './HorseMindHandIdentity.js';
import {
  mergeHorseObservationWindows,
  normalizeHorseObservationWindow,
  observeHorseObservationWindow,
  type HorseObservationWindow,
} from './HorseObservationWindow.js';
import type { ActionRecord, SeatPlayer } from '../types.js';

const TABLE = '00000000-0000-4000-8000-000000000001';
const complete = (fromMs: number, toMs = fromMs): HorseObservationWindow => ({
  version: 1,
  coverage: 'complete',
  fromMs,
  toMs,
});
const unknown: HorseObservationWindow = {
  version: 1,
  coverage: 'unknown',
  fromMs: null,
  toMs: null,
};
const act = (timestamp: number, action: ActionRecord['action'] = 'check'): ActionRecord => ({
  userId: 'opponent',
  seat: 2,
  stage: 'flop',
  action,
  amount: 0,
  timestamp,
});
const observe = (actions: ActionRecord[], handNumber = 1_000_001) =>
  HorseMind.observe(actions, [], horseMindHandIdentity(TABLE, handNumber));
const stats = () => HorseMind.getStats('opponent')!;

beforeEach(() => HorseMind.reset());
afterEach(() => {
  HorseMind.reset();
  vi.restoreAllMocks();
});

describe('original observation window semantics', () => {
  it.each([
    undefined,
    null,
    {},
    { ...complete(10), version: 2 },
    complete(0),
    complete(2, 1),
    complete(1, Infinity),
    complete(1.5),
    { ...complete(1), invented: true },
  ])('refuses absent or malformed authority: %j', (value) => {
    expect(normalizeHorseObservationWindow(value)).toEqual(unknown);
  });

  it('detaches and freezes the bounded original envelope', () => {
    const input = { ...complete(10, 20) };
    const value = normalizeHorseObservationWindow(input);
    input.toMs = 999;
    expect(value).toEqual(complete(10, 20));
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('known contributions do not qualify an unknown legacy prefix', () => {
    expect(mergeHorseObservationWindows(undefined, complete(20, 30))).toEqual({
      ...complete(20, 30),
      coverage: 'partial',
    });
    expect(mergeHorseObservationWindows(complete(20, 30), complete(10, 25))).toEqual(
      complete(10, 30)
    );
    expect(observeHorseObservationWindow(undefined, 20, false)).toEqual(complete(20));
    expect(observeHorseObservationWindow(undefined, 20, true)).toEqual({
      ...complete(20),
      coverage: 'partial',
    });
    expect(observeHorseObservationWindow(complete(20), undefined, true)).toEqual({
      ...complete(20),
      coverage: 'partial',
    });
  });
});

describe('HorseMind contribution windows', () => {
  it('uses original action times, including an out-of-order source, without reading the clock', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw Error('wall clock is not source');
    });
    observe([act(200)]);
    observe([act(100)], 1_000_002);
    expect(stats().sourceWindow).toEqual(complete(100, 200));
    expect(stats().hands).toBe(2);
    expect(stats().checks).toBe(2);
  });

  it('does not refresh a duplicate controller ordinal or a noncontributing action', () => {
    observe([act(100)]);
    const before = { ...stats() };
    observe([act(900)]);
    expect(stats()).toEqual(before);
    observe([act(100), act(999, 'discard')]);
    expect(stats()).toEqual(before);
  });

  it('missing original timestamps remain unknown and later valid actions yield partial bounds', () => {
    observe([act(0)]);
    expect(stats().sourceWindow).toEqual(unknown);
    observe([act(300)], 1_000_002);
    expect(stats().sourceWindow).toEqual({ ...complete(300), coverage: 'partial' });
    expect(stats().hands).toBe(2);
  });

  it('keeps a legacy pooled prefix unknown while new scoped contributions have their own envelope', () => {
    HorseMind.importStats([{ user_id: 'opponent', hands: 40, folds: 10, facedAggr: 20 }]);
    HorseMind.setDecisionScope('holdem:short');
    observe([act(100)]);
    expect(stats().sourceWindow).toEqual({ ...complete(100), coverage: 'partial' });
    expect(HorseMind.getScopedStats('opponent', 'holdem:short')!.sourceWindow).toEqual(
      complete(100)
    );
    HorseMind.setDecisionScope('omaha:short');
    observe([act(250)], 1_000_002);
    expect(HorseMind.getScopedStats('opponent', 'omaha:short')!.sourceWindow).toEqual(
      complete(250)
    );
    expect(HorseMind.getScopedStats('opponent', 'holdem:short')!.sourceWindow).toEqual(
      complete(100)
    );
    expect(stats().sourceWindow).toEqual({ ...complete(100, 250), coverage: 'partial' });
  });

  it('does not upgrade a nonzero scoped legacy aggregate', () => {
    HorseMind.importScoped([{ user_id: 'opponent', scope: 'holdem:short', hands: 40 }]);
    HorseMind.setDecisionScope('holdem:short');
    observe([act(300)]);
    expect(HorseMind.getScopedStats('opponent', 'holdem:short')!.sourceWindow).toEqual({
      ...complete(300),
      coverage: 'partial',
    });
  });

  it('original read snapshots remain immutable while live counters advance', () => {
    observe([act(100)]);
    const snapshot = HorseMind.snapshotDecisionReads(
      [{ user_id: 'opponent' }] as SeatPlayer[],
      null
    );
    const exported = HorseMind.exportDirty()[0];
    observe([act(200)], 1_000_002);
    expect(stats().sourceWindow).toEqual(complete(100, 200));
    expect(snapshot.stats.get('opponent')!.sourceWindow).toEqual(complete(100));
    expect(exported.sourceWindow).toEqual(complete(100));
    expect(Object.isFrozen(exported.sourceWindow)).toBe(true);
    HorseMind.runInSandbox(snapshot, () => {
      expect(stats().sourceWindow).toEqual(complete(100));
    });
    expect(stats().sourceWindow).toEqual(complete(100, 200));
  });

  it('preserves pooled recency contribution timestamps through a decay', () => {
    for (let i = 1; i <= 24; i++) observe([act(i * 100)], 1_000_000 + i);
    expect(stats().hands).toBe(24);
    expect(stats().rHands).toBe(12);
    expect(stats().sourceWindow).toEqual(complete(100, 2400));
  });

  it('carries real completed-hand source bounds for deep counters and ignores repeat delivery', () => {
    const actions = [
      { userId: 'opponent', stage: 'preflop', action: 'raise', timestamp: 100 },
      { userId: 'raiser', stage: 'preflop', action: 'raise', timestamp: 200 },
      { userId: 'opponent', stage: 'preflop', action: 'fold', timestamp: 300 },
    ];
    HorseMind.observeHandComplete('completed-original', actions, 100, null, 'holdem:short');
    expect(stats().f3bOpps).toBe(1);
    expect(stats().f3bFolds).toBe(1);
    expect(stats().sourceWindow).toEqual(complete(100, 300));
    expect(HorseMind.getScopedStats('opponent', 'holdem:short')!.sourceWindow).toEqual(
      complete(100, 300)
    );
    HorseMind.observeHandComplete(
      'completed-original',
      actions.map((a) => ({ ...a, timestamp: 999 })),
      100
    );
    expect(stats().sourceWindow).toEqual(complete(100, 300));
    expect(stats().f3bOpps).toBe(1);
  });

  it('a completed legacy source cannot manufacture complete bounds', () => {
    HorseMind.observeHandComplete(
      'legacy-completion',
      [
        { userId: 'opponent', stage: 'preflop', action: 'raise' },
        { userId: 'raiser', stage: 'preflop', action: 'raise', timestamp: 200 },
        { userId: 'opponent', stage: 'preflop', action: 'fold', timestamp: 300 },
      ],
      100,
      null,
      'holdem:short'
    );
    expect(stats().sourceWindow).toEqual({ ...complete(200, 300), coverage: 'partial' });
    expect(HorseMind.getScopedStats('opponent', 'holdem:short')!.sourceWindow).toEqual({
      ...complete(200, 300),
      coverage: 'partial',
    });
  });

  it('no completed-hand counter change means no window or dirty row', () => {
    observe([act(100)]);
    HorseMind.exportDirty();
    HorseMind.observeHandComplete('no-deep-change', [act(999)], 100);
    expect(stats().sourceWindow).toEqual(complete(100));
    expect(HorseMind.dirtyCount()).toBe(0);
  });
});

describe('HorseMind import compatibility', () => {
  it('imports immutable qualified metadata while omitted legacy metadata stays unknown', () => {
    const window = { ...complete(10, 30) };
    HorseMind.importStats([{ user_id: 'opponent', hands: 5, sourceWindow: window }]);
    window.toMs = 999;
    expect(stats().sourceWindow).toEqual(complete(10, 30));
    HorseMind.importStats([{ user_id: 'opponent', hands: 6, checks: 2 }]);
    expect(stats().sourceWindow).toEqual({ ...complete(10, 30), coverage: 'partial' });
    expect(stats().hands).toBe(6);
  });

  it('a newer qualified import cannot erase an unknown retained recency prefix', () => {
    HorseMind.importStats([{ user_id: 'opponent', hands: 5, rHands: 4, rFolds: 2 }]);
    HorseMind.importStats([
      {
        user_id: 'opponent',
        hands: 6,
        rHands: 1,
        sourceWindow: complete(100, 200),
      },
    ]);
    expect(stats().rHands).toBe(4);
    expect(stats().rFolds).toBe(2);
    expect(stats().sourceWindow).toEqual({ ...complete(100, 200), coverage: 'partial' });
  });

  it('stale imports cannot refresh either pooled or scoped source windows', () => {
    HorseMind.importStats([{ user_id: 'opponent', hands: 10, sourceWindow: complete(10, 30) }]);
    HorseMind.importScoped([
      {
        user_id: 'opponent',
        scope: 'holdem:short',
        hands: 10,
        sourceWindow: complete(10, 30),
      },
    ]);
    expect(
      HorseMind.importStats([
        {
          user_id: 'opponent',
          hands: 9,
          sourceWindow: complete(999),
        },
      ])
    ).toBe(0);
    expect(
      HorseMind.importScoped([
        {
          user_id: 'opponent',
          scope: 'holdem:short',
          hands: 10,
          sourceWindow: complete(999),
        },
      ])
    ).toBe(0);
    expect(stats().sourceWindow).toEqual(complete(10, 30));
    expect(HorseMind.getScopedStats('opponent', 'holdem:short')!.sourceWindow).toEqual(
      complete(10, 30)
    );
  });

  it('scoped import merges windows without replacing larger existing counters', () => {
    HorseMind.importScoped([
      {
        user_id: 'opponent',
        scope: 'omaha:short',
        hands: 5,
        checks: 9,
      },
    ]);
    HorseMind.importScoped([
      {
        user_id: 'opponent',
        scope: 'omaha:short',
        hands: 6,
        checks: 3,
        sourceWindow: complete(100),
      },
    ]);
    const value = HorseMind.getScopedStats('opponent', 'omaha:short')!;
    expect(value.checks).toBe(9);
    expect(value.sourceWindow).toEqual({ ...complete(100), coverage: 'partial' });
  });
});
