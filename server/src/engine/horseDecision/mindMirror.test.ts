/**
 * ONE FLOOR, ONE READ (2026-10-16): a shard that learns another table's
 * completed hand must end up holding exactly the read the owning shard holds,
 * and must not disturb the dedupe of its own hands in flight. See mindMirror.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HorseMind, type ReadScope } from '../HorseMind.js';
import { HorseMindMirror, addHandContribution } from './mindMirror.js';
import { defaultHorseDecisionWorkerDependencies } from './workerRuntime.js';
import type { ObserveCompletedHandRequest } from './protocol.js';

const TABLE = '10000000-0000-4000-8000-0000000000aa';
const OTHER_TABLE = '10000000-0000-4000-8000-0000000000bb';
const SCOPE: ReadScope = 'holdem:full';
const PLAYERS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000004',
];

let uuidSeq = 0;
const committedId = (): string =>
  `30000000-0000-4000-8000-${(++uuidSeq).toString(16).padStart(12, '0')}`;

/** A completed hand with a 3-bet, a flop c-bet and folds, varied by `n`. */
function hand(n: number, table = TABLE, players = PLAYERS): ObserveCompletedHandRequest {
  const number = 1_000_000 + n;
  const t0 = 1_760_000_000_000 + n * 60_000;
  const [a, b, c, d] = players as [string, string, string, string];
  const actions =
    n % 3 === 0
      ? [
          { seat: 1, userId: a, action: 'raise', amount: 6, stage: 'preflop', timestamp: t0 },
          {
            seat: 2,
            userId: b,
            action: 'raise',
            amount: 18,
            stage: 'preflop',
            timestamp: t0 + 900,
          },
          { seat: 3, userId: c, action: 'fold', amount: 0, stage: 'preflop', timestamp: t0 + 1800 },
          { seat: 4, userId: d, action: 'fold', amount: 0, stage: 'preflop', timestamp: t0 + 2500 },
          {
            seat: 1,
            userId: a,
            action: 'call',
            amount: 12,
            stage: 'preflop',
            timestamp: t0 + 4000,
          },
          { seat: 2, userId: b, action: 'bet', amount: 20, stage: 'flop', timestamp: t0 + 9000 },
          { seat: 1, userId: a, action: 'fold', amount: 0, stage: 'flop', timestamp: t0 + 12000 },
        ]
      : [
          { seat: 3, userId: c, action: 'call', amount: 2, stage: 'preflop', timestamp: t0 },
          { seat: 4, userId: d, action: 'raise', amount: 8, stage: 'preflop', timestamp: t0 + 700 },
          { seat: 1, userId: a, action: 'call', amount: 8, stage: 'preflop', timestamp: t0 + 1500 },
          { seat: 2, userId: b, action: 'fold', amount: 0, stage: 'preflop', timestamp: t0 + 2000 },
          { seat: 3, userId: c, action: 'call', amount: 6, stage: 'preflop', timestamp: t0 + 2600 },
          { seat: 4, userId: d, action: 'bet', amount: 10, stage: 'flop', timestamp: t0 + 7000 },
          { seat: 1, userId: a, action: 'raise', amount: 30, stage: 'flop', timestamp: t0 + 9000 },
          { seat: 3, userId: c, action: 'fold', amount: 0, stage: 'flop', timestamp: t0 + 9500 },
          { seat: 4, userId: d, action: 'call', amount: 20, stage: 'flop', timestamp: t0 + 11000 },
          { seat: 4, userId: d, action: 'bet', amount: 60, stage: 'river', timestamp: t0 + 20000 },
          { seat: 1, userId: a, action: 'call', amount: 60, stage: 'river', timestamp: t0 + 26000 },
        ];
  return {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: n + 1,
    generation: number,
    fence: `${table}:${number}:9:observe`,
    handKey: `${table}:${number}`,
    committedHandId: committedId(),
    actions,
    bigBlind: 2,
    showdown: n % 3 === 0 ? null : [{ user_id: d, mucked: false, hand_name: 'Two Pair' }],
    scope: SCOPE,
  };
}

const learnAsOwner = (request: ObserveCompletedHandRequest): void =>
  defaultHorseDecisionWorkerDependencies.observeCompletedHand(request);

function readOf(players = PLAYERS) {
  return players.map((id) => ({
    id,
    stats: HorseMind.getStats(id) ? { ...HorseMind.getStats(id)! } : null,
    scoped: HorseMind.getScopedStats(id, SCOPE)
      ? { ...HorseMind.getScopedStats(id, SCOPE)! }
      : null,
    pairs: players.map((other) => HorseMind.getPair(id, other) ?? null),
    exploit: HorseMind.getExploitCounters(id, SCOPE)
      ? structuredClone(HorseMind.getExploitCounters(id, SCOPE)!)
      : null,
  }));
}

/** Every hand, `maniac` opens to a pot-size raise and the rest fold to him. */
function maniacHand(n: number, maniac: string, table = TABLE): ObserveCompletedHandRequest {
  const number = 2_000_000 + n;
  const t0 = 1_761_000_000_000 + n * 60_000;
  const others = PLAYERS.filter((p) => p !== maniac);
  const actions = [
    { seat: 1, userId: maniac, action: 'raise', amount: 7, stage: 'preflop', timestamp: t0 },
    ...others.map((userId, i) => ({
      seat: i + 2,
      userId,
      action: 'fold',
      amount: 0,
      stage: 'preflop',
      timestamp: t0 + 700 * (i + 1),
    })),
  ];
  return {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: n + 1,
    generation: number,
    fence: `${table}:${number}:9:observe`,
    handKey: `${table}:${number}`,
    committedHandId: committedId(),
    actions,
    bigBlind: 2,
    showdown: null,
    scope: SCOPE,
  };
}

describe('a mirrored hand teaches exactly what the owner learned', () => {
  beforeEach(() => HorseMind.reset());
  afterEach(() => HorseMind.reset());

  it.each([
    ['an empty memory', 0],
    ['a memory one hand short of the recency halving', 22],
    ['a memory well past several halvings', 61],
  ])('from %s', (_name, history) => {
    const hands = Array.from({ length: history + 3 }, (_, i) => hand(i));
    // The owner: every hand through the owner's learner.
    for (const h of hands) learnAsOwner(h);
    const owner = readOf();

    // Another shard: the same history, then the last three hands mirrored.
    HorseMind.reset();
    for (const h of hands.slice(0, history)) learnAsOwner(h);
    const mirror = new HorseMindMirror();
    for (const h of hands.slice(history)) expect(mirror.learn(h, learnAsOwner)).toBe('learned');
    expect(readOf()).toEqual(owner);
  });

  it('learns a hand once, however often it is delivered', () => {
    const mirror = new HorseMindMirror();
    const h = hand(5);
    expect(mirror.learn(h, learnAsOwner)).toBe('learned');
    const once = readOf();
    expect(mirror.learn(structuredClone(h), learnAsOwner)).toBe('duplicate');
    expect(readOf()).toEqual(once);
  });

  it('keeps its dedupe bounded', () => {
    const mirror = new HorseMindMirror(10);
    for (let i = 0; i < 25; i++) mirror.learn(hand(i, OTHER_TABLE), learnAsOwner);
    expect(mirror.rememberedHands).toBe(10);
  });

  it('marks nothing for the persistence flush: the owner flushes its own players', () => {
    const mirror = new HorseMindMirror();
    mirror.learn(hand(1), learnAsOwner);
    expect(HorseMind.dirtyCount()).toBe(0);
    expect(HorseMind.dirtyScopedCount()).toBe(0);
    expect(HorseMind.dirtyPairsCount()).toBe(0);
    expect(HorseMind.getStats(PLAYERS[0]!)?.hands).toBe(1);
  });

  /*
   * WHY THE SANDBOX. Feeding the rest of the floor through observe() would
   * evict this shard's own in-flight hand flags (20,000, oldest first), and a
   * player whose preflop flag is gone is counted into `hands` again on the
   * flop. Mirrored hands never touch those caches.
   */
  it("never displaces the dedupe of this shard's own hand in flight", () => {
    const own = hand(7);
    const preflop = own.actions!.filter((a) => a.stage === 'preflop');
    const identity = { version: 1 as const, tableId: TABLE, handNumber: own.generation };
    HorseMind.setDecisionScope(SCOPE);
    HorseMind.observe(preflop as never, [], identity);
    HorseMind.setDecisionScope(null);
    const handsBefore = HorseMind.getStats(PLAYERS[0]!)!.hands;

    // ~2,500 hands of the rest of the floor: far past 20,000 flags if they
    // went through the live caches.
    const others = Array.from({ length: 4 }, (_, i) =>
      Array.from(
        { length: 4 },
        (_, j) => `40000000-0000-4000-8000-${(i * 4 + j).toString(16).padStart(12, '0')}`
      )
    );
    const mirror = new HorseMindMirror();
    for (let i = 0; i < 2_500; i++)
      mirror.learn(hand(10_000 + i, OTHER_TABLE, others[i % others.length]), learnAsOwner);

    // The own hand completes: its preflop actions must not count again.
    learnAsOwner(own);
    expect(HorseMind.getStats(PLAYERS[0]!)!.hands).toBe(handsBefore);
  });
});

describe('the opponent-exploit read crosses shards (one floor, one read)', () => {
  beforeEach(() => HorseMind.reset());
  afterEach(() => {
    HorseMind.setDecisionScope(null);
    HorseMind.reset();
  });

  it('a maniac read on one shard engages identically on another', () => {
    const maniac = PLAYERS[0]!;
    const hands = Array.from({ length: 14 }, (_, i) => maniacHand(i, maniac));

    // The owning shard learns every hand itself.
    for (const h of hands) learnAsOwner(h);
    HorseMind.setDecisionScope(SCOPE);
    const ownerRead = HorseMind.opponentRead(maniac);
    HorseMind.setDecisionScope(null);
    const ownerRows = readOf();
    expect(ownerRead).not.toBeNull();

    // Another shard sees none of those tables: it learns them only by mirror.
    HorseMind.reset();
    const mirror = new HorseMindMirror();
    for (const h of hands) expect(mirror.learn(h, learnAsOwner)).toBe('learned');
    HorseMind.setDecisionScope(SCOPE);
    expect(HorseMind.opponentRead(maniac)).toEqual(ownerRead);
    HorseMind.setDecisionScope(null);
    expect(readOf()).toEqual(ownerRows);
  });
});

describe('addHandContribution', () => {
  it('adds lifetime counters and applies the recency halving before this hand counts', () => {
    const live = {
      hands: 40,
      vpip: 10,
      pfr: 5,
      threeBet: 1,
      aggr: 20,
      passive: 10,
      folds: 4,
      facedAggr: 8,
      cbetOpps: 3,
      cbetFolds: 1,
      f3bOpps: 2,
      f3bFolds: 1,
      bigBetSD: 0,
      bigBetSDStrong: 0,
      riverBetOpps: 2,
      riverBetFolds: 1,
      rHands: 23,
      rFolds: 4,
      rFacedAggr: 6,
      rAggr: 8,
      rPassive: 2,
      checks: 5,
      postAggr: 7,
      postPassive: 3,
      rChecks: 2,
      snapBetSD: 0,
      snapBetSDStrong: 0,
      tankBetSD: 0,
      tankBetSDStrong: 0,
      riverCallSD: 0,
      riverCallSDWeak: 0,
    };
    const one = {
      ...Object.fromEntries(Object.keys(live).map((k) => [k, 0])),
      hands: 1,
      rHands: 1,
      aggr: 1,
      rAggr: 1,
    } as typeof live;
    const merged = addHandContribution(live, one);
    expect(merged.hands).toBe(41);
    expect(merged.aggr).toBe(21);
    // 23 + 1 = 24 halves the window to 12; this hand's rAggr lands after it.
    expect(merged.rHands).toBe(12);
    expect(merged.rAggr).toBe(8 / 2 + 1);
    expect(merged.rFolds).toBe(2);
  });
});
