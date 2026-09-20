import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  horseMindHandIdentity,
  horseMindHandIdentityKey,
  horseMindHandFromDecision,
  horseMindHandFromCompletion,
  horseMindHandFromHistory,
} from '../../../engine/HorseMindHandIdentity.js';
import { HorseMind } from '../../../engine/HorseMind.js';
import { defaultHorseDecisionWorkerDependencies as defaults } from '../../../engine/horseDecision/workerRuntime.js';
import type { ActionRecord } from '../../../types.js';
import type { ObserveCompletedHandRequest } from '../../../engine/horseDecision/protocol.js';
const tableA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tableB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const lease = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const hero = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const opponent = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const decision = () => ({
  fence: `${tableA}:1000001:1:${lease}:3`,
  generation: 3,
  player: { seat: 1 },
});
const completion = (table = tableA, hand = 1000001): ObserveCompletedHandRequest => ({
  type: 'OBSERVE_COMPLETED_HAND',
  requestId: 1,
  fence: `${table}:${hand}:${lease}:observe`,
  generation: hand,
  handKey: `${table}:${hand}`,
  committedHandId: id,
  actions: [],
  bigBlind: 2,
  scope: 'holdem:hu',
});
const history = (): ActionRecord[] => [
  {
    seat: 1,
    userId: hero,
    action: 'raise',
    amount: 6,
    timestamp: 1700000000000,
    stage: 'preflop',
    isFullRaise: true,
  },
  {
    seat: 2,
    userId: opponent,
    action: 'call',
    amount: 6,
    timestamp: 1700000000001,
    stage: 'preflop',
  },
  {
    seat: 1,
    userId: hero,
    action: 'bet',
    amount: 10,
    timestamp: 1700000000002,
    stage: 'river',
    isFullRaise: true,
  },
  {
    seat: 2,
    userId: opponent,
    action: 'fold',
    amount: 0,
    timestamp: 1700000000003,
    stage: 'river',
  },
];
beforeEach(() => HorseMind.reset());
afterEach(() => HorseMind.reset());

describe('real producer coordinate, distinct from acceptance authority', () => {
  it('matches the five-part decision, four-part completion and stored history coordinate', () => {
    const expected = { version: 1, tableId: tableA, handNumber: 1000001 };
    expect(horseMindHandFromDecision(decision())).toEqual(expected);
    expect(horseMindHandFromCompletion(completion())).toEqual(expected);
    expect(horseMindHandFromHistory({ id, table_id: tableA, hand_number: 1000001 })).toEqual(
      expected
    );
    expect(Object.isFrozen(horseMindHandFromDecision(decision()))).toBe(true);
  });
  it.each([1000000, Number.MAX_SAFE_INTEGER])(
    'retains exact supported integer boundary %s',
    (handNumber) => {
      expect(horseMindHandIdentity(tableA, handNumber)?.handNumber).toBe(handNumber);
    }
  );
  it.each(
    [0, 999999, 1000000.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1000001', ['1000001']].map(
      (hand) => ({ hand })
    )
  )('refuses missing legacy or unsafe hand identity $hand', ({ hand }) => {
    expect(horseMindHandIdentity(tableA, hand)).toBeNull();
  });
  it.each(['table', '', `${tableA}:another`, [tableA], null].map((tableId) => ({ tableId })))(
    'does not coerce or truncate the table UUID $tableId',
    ({ tableId }) => {
      expect(horseMindHandIdentity(tableId, 1000001)).toBeNull();
    }
  );
  it.each([
    `${tableA}:1000001:${lease}:observe`,
    `${tableA}:1000001:1:${lease}:3:extra`,
    `${tableA}:01000001:1:${lease}:3`,
    `${tableA}:1000001:2:${lease}:3`,
    `${tableA}:1000001:1:${lease}:4`,
    `${tableA}:1000001:1:unverified:3`,
    `${tableA}:9007199254740993:1:${lease}:3`,
    `${tableA}:1000001:01:${lease}:3`,
  ])('refuses malformed or mismatched decision fence %s', (fence) => {
    expect(horseMindHandFromDecision({ ...decision(), fence })).toBeNull();
  });
  it.each([
    { committedHandId: undefined },
    { handKey: `${tableB}:1000001` },
    { generation: 1000002 },
    { fence: `${tableA}:1000001:1:${lease}:3` },
    { committedHandId: [id] },
  ])('refuses incomplete or conflicting accepted coordinate %#', (patch) => {
    expect(horseMindHandFromCompletion({ ...completion(), ...patch } as never)).toBeNull();
  });
  it.each([
    { id },
    { id, table_id: tableA },
    { id: undefined, table_id: tableA, hand_number: 1000001 },
    { id, table_id: tableA, hand_number: 42 },
  ])('does not recover missing stored coordinates from a UUID %#', (row) => {
    expect(horseMindHandFromHistory(row)).toBeNull();
  });
  it('normalizes UUID case without substituting the accepted UUID or lease into basic identity', () => {
    const first = horseMindHandIdentity(tableA.toUpperCase(), 1000001)!;
    expect(first.tableId).toBe(tableA);
    const otherLease = completion();
    otherLease.fence = `${tableA}:1000001:${tableB}:observe`;
    expect(horseMindHandFromCompletion(otherLease)).toEqual(first);
    expect(horseMindHandIdentityKey(first)).toBe(`mind-hand-v1:${tableA}:1000001`);
    expect(horseMindHandIdentityKey({ ...first, accepted: true })).toBeNull();
  });
  it('refuses an inherited version disguised by a third unrelated own key', () => {
    const supplied = Object.assign(Object.create({ version: 1 }), {
      tableId: tableA,
      handNumber: 1000001,
      extra: true,
    });
    expect(horseMindHandIdentityKey(supplied)).toBeNull();
    HorseMind.observe(history(), [], supplied);
    expect(HorseMind.getStats(hero)).toBeUndefined();
  });
});

describe('bounded per-hand basic deduplication', () => {
  it('counts the same actors, clocks and actions at two tables, then rejects duplicate completion replay', () => {
    const a = completion(),
      b = completion(tableB, 1000002);
    a.actions = history();
    b.actions = history();
    b.scope = 'omaha:hu';
    const before = structuredClone([a, b]);
    HorseMind.setDecisionScope('holdem:hu');
    HorseMind.observe(history().slice(0, 3), [], horseMindHandFromCompletion(a));
    HorseMind.setDecisionScope('omaha:hu');
    HorseMind.observe(history().slice(0, 3), [], horseMindHandFromCompletion(b));
    HorseMind.setDecisionScope(null);
    defaults.observeCompletedHand(a);
    defaults.observeCompletedHand(b);
    expect(HorseMind.getStats(opponent)).toMatchObject({
      hands: 2,
      vpip: 2,
      passive: 2,
      folds: 2,
      facedAggr: 4,
      riverBetOpps: 2,
      riverBetFolds: 2,
    });
    expect(HorseMind.getStats(hero)).toMatchObject({ hands: 2, vpip: 2, pfr: 2, aggr: 4 });
    expect(HorseMind.getScopedStats(opponent, 'holdem:hu')?.folds).toBe(1);
    expect(HorseMind.getScopedStats(opponent, 'omaha:hu')?.folds).toBe(1);
    defaults.observeCompletedHand(b);
    defaults.observeCompletedHand(a);
    expect(HorseMind.getStats(opponent)?.folds).toBe(2);
    expect([a, b]).toEqual(before);
  });
  it('separates two allocated hands at the same table with identical first actions', () => {
    HorseMind.observe(history(), [], horseMindHandIdentity(tableA, 1000001));
    HorseMind.observe(history(), [], horseMindHandIdentity(tableA, 1000002));
    expect(HorseMind.getStats(opponent)?.hands).toBe(2);
    expect(HorseMind.getStats(hero)?.pfr).toBe(2);
  });
  it('counts repeated same-clock controller checks by sequence position while replay remains idempotent', () => {
    const actions = [
      { ...history()[0], action: 'check', amount: 0, stage: 'flop' },
      { ...history()[1], action: 'check', amount: 0, stage: 'flop' },
      { ...history()[0], action: 'check', amount: 0, stage: 'turn' },
    ] as ActionRecord[];
    const identity = horseMindHandIdentity(tableA, 1000001);
    HorseMind.observe(actions.slice(0, 2), [], identity);
    HorseMind.observe(actions, [], identity);
    HorseMind.observe(actions, [], identity);
    expect(HorseMind.getStats(hero)).toMatchObject({ hands: 1, checks: 2, rChecks: 2 });
  });
  it('deduplicates pooled history then completion without claiming scoped replay coverage', () => {
    const event = completion();
    event.actions = history();
    HorseMind.observe(
      history(),
      [],
      horseMindHandFromHistory({ id, table_id: tableA, hand_number: 1000001 })
    );
    defaults.observeCompletedHand(event);
    expect(HorseMind.getStats(opponent)).toMatchObject({ hands: 1, folds: 1, facedAggr: 2 });
    // This explicit replay sequence is not a demonstrated current boot race:
    // GameServer waits for worker READY before it discovers/deals tables.
    // Previously pooled basic events are not retroactively added to a scope.
    expect(HorseMind.getScopedStats(opponent, 'holdem:hu')).toBeUndefined();
  });
  it.each([
    null,
    { version: 1, tableId: tableA, handNumber: 1 },
    { version: 1, tableId: tableA, handNumber: 1000001, extra: true },
  ])('refuses explicit missing/malformed identity without global fallback %#', (identity) => {
    HorseMind.observe(history(), [], identity as never);
    expect(HorseMind.getStats(hero)).toBeUndefined();
  });
  it('preserves explicitly unqualified direct legacy callers, without migrating legacy dedup into the new namespace', () => {
    HorseMind.observe(history(), []);
    HorseMind.observe(history(), []);
    expect(HorseMind.getStats(opponent)?.hands).toBe(1);
    const key = HorseMind.handKeyOf(history());
    expect(key).toBe(`1700000000000:${hero}`);
    HorseMind.notePlan(key, hero, true);
    expect(HorseMind.getPlan(key, hero)).toBe(true);
  });
});
