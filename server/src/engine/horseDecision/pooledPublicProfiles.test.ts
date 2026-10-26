import { describe, it, expect, afterEach } from 'vitest';
import { PooledPublicProfiles } from './pooledPublicProfiles.js';
import { HorseObserverReads } from './observerReads.js';
import { freshExploitCounters } from '../HorseOpponentExploit.js';
import { HorseMind } from '../HorseMind.js';
import { horseObserverReadContextFromRequest } from '../HorseObserverReadContext.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import {
  horseObserverReadsWereIndependent,
  horseObserverReadsUsedPublicPool,
} from '../HorseObserverReadEvidence.js';
import type { FastHorseDecisionRequest, ObserveCompletedHandRequest } from './protocol.js';
const table = '10000000-0000-4000-8000-000000000001';
const actor = '20000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const opponent = '30000000-0000-4000-8000-000000000001';
const committed = '40000000-0000-4000-8000-000000000001';
const lease = '50000000-0000-4000-8000-000000000001';
function request(
  id = actor,
  format = 'cash',
  variant = 'nlh',
  hand = 1000001
): FastHorseDecisionRequest {
  return {
    type: 'DECIDE_FAST',
    requestId: 1,
    generation: 7,
    fence: `${table}:${hand}:1:${lease}:7`,
    decisionKey: '',
    decisionTimeMs: 1000,
    handJournalContext: captureHorseHandJournalContext([]),
    player: { user_id: id, seat: 1 },
    gameState: {
      gameVariant: variant,
      format,
      gameMode: format === 'cash' ? 'cash' : 'tournament',
      ...(format === 'cash' ? {} : { tournament: { contextStatus: 'complete' } }),
      dealtSeatIds: [1, 2],
      players: [
        { user_id: id, seat: 1 },
        { user_id: opponent, seat: 2 },
      ],
    },
  } as never;
}
function completion(hand = 1000001): ObserveCompletedHandRequest {
  return {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: 2,
    generation: hand,
    fence: `${table}:${hand}:${lease}:observe`,
    handKey: `${table}:${hand}`,
    committedHandId: committed,
    actions: [],
    bigBlind: 2,
    results: [{ user_id: opponent, net: 20 }],
  };
}
function learn() {
  HorseMind.observe(
    [
      { userId: opponent, seat: 2, action: 'raise', amount: 8, stage: 'preflop', timestamp: 1 },
    ] as never,
    []
  );
}

function shared() {
  const done = completion();
  done.actions = [
    { userId: opponent, seat: 2, action: 'raise', amount: 8, stage: 'preflop', timestamp: 1 },
  ];
  done.observerParticipants = {
    version: 1,
    handKey: `${table}:1000001:${lease}`,
    status: 'bound',
    contexts: [horseObserverReadContextFromRequest(request())!],
  };
  done.durableOpponentProfiles = [
    {
      user_id: opponent,
      variant: 'nlh',
      mode: 'cash',
      size: 'hu',
      observed_hands: 60,
      initialized: true,
      counters: { ...freshExploitCounters(), hands: 30, vpip: 29, pfr: 29, rfiOpp: 30, rfi: 29 },
    },
  ];
  return done;
}
afterEach(() => HorseMind.reset());
describe('owner-authorized public herd profiles', () => {
  it('shares only saved public counters with another horse before its cutoff', () => {
    const pool = new PooledPublicProfiles(() => 100);
    expect(pool.observe(shared())).toBe(1);
    const packet = pool.read(request(other));
    expect(packet?.rows[0]?.counters.pfr).toBe(29);
    expect(packet?.receipt).toMatchObject({ availableAtMs: 100, profiles: 1 });
    expect(pool.observe(shared())).toBe(0);
    expect(pool.read({ ...request(other), decisionTimeMs: 99 })).toBeNull();
    for (const r of [request(other, 'mtt'), request(other, 'cash', 'plo5')])
      expect(pool.read(r)).toBeNull();
    packet!.rows[0]!.counters.pfr = 0;
    expect(pool.read(request(other))?.rows[0]?.counters.pfr).toBe(29);
  });
  it('projects away unknown fields, including cards and private plans', () => {
    const pool = new PooledPublicProfiles(() => 100);
    const hand = shared();
    Object.assign(hand.durableOpponentProfiles![0]!, {
      holeCards: ['As', 'Ah'],
      plans: ['private'],
    });
    expect(pool.observe(hand)).toBe(1);
    const profile = pool.read(request(other))!.rows[0]!;
    expect(Object.keys(profile).sort()).toEqual([
      'counters',
      'initialized',
      'mode',
      'observed_hands',
      'size',
      'user_id',
      'variant',
    ]);
  });
  it.each([
    'unknown',
    'uncommitted',
    'wrong_actor',
    'wrong_variant',
    'wrong_mode',
    'wrong_size',
    'duplicate',
    'invalid_counter',
  ])('refuses %s without partial import', (kind) => {
    const pool = new PooledPublicProfiles(() => 100);
    const hand = shared();
    const p = hand.durableOpponentProfiles![0]!;
    if (kind === 'unknown') hand.observerParticipants!.status = 'unknown';
    if (kind === 'uncommitted') delete hand.committedHandId;
    if (kind === 'wrong_actor') p.user_id = other;
    if (kind === 'wrong_variant') p.variant = 'plo5';
    if (kind === 'wrong_mode') p.mode = 'tournament';
    if (kind === 'wrong_size') p.size = 'full';
    if (kind === 'duplicate') hand.durableOpponentProfiles!.push(p);
    if (kind === 'invalid_counter') p.counters.pfr = 31;
    expect(pool.observe(hand)).toBe(0);
    expect(pool.read(request(other))).toBeNull();
  });
  it('does not regress versions, relabel future receipts, or learn through a regressed clock', () => {
    let now = 100;
    const pool = new PooledPublicProfiles(() => now);
    expect(pool.observe(shared())).toBe(1);
    const newer = shared();
    newer.generation++;
    newer.handKey = `${table}:1000002`;
    newer.fence = `${table}:1000002:${lease}:observe`;
    newer.observerParticipants!.handKey = `${table}:1000002:${lease}`;
    newer.durableOpponentProfiles![0]!.observed_hands = 61;
    now = 2000;
    expect(pool.observe(newer)).toBe(1);
    expect(pool.read(request(other))).toBeNull();
    expect(pool.read({ ...request(other), decisionTimeMs: 3000 })?.rows[0]?.observed_hands).toBe(
      61
    );
    now = 50;
    newer.generation++;
    newer.handKey = `${table}:1000003`;
    newer.fence = `${table}:1000003:${lease}:observe`;
    newer.observerParticipants!.handKey = `${table}:1000003:${lease}`;
    newer.durableOpponentProfiles![0]!.observed_hands = 62;
    expect(pool.observe(newer)).toBe(0);
  });
  it('wires another horse into the real sandbox read and labels pooling honestly', () => {
    const bank = new HorseObserverReads(20, 20, () => 100);
    // This shard has no original participant entry. The bound accepted packet
    // still delivers public notes to another horse's first local decision.
    bank.complete(shared(), () => {});
    const next = request(other);
    bank.run(next, () => {
      HorseMind.setDecisionScope('holdem:hu', 'nlh', 'cash');
      expect(HorseMind.opponentRead(opponent)?.stats.pfr).toBeDefined();
      expect(HorseMind.getStats(opponent)).toBeUndefined();
    });
    const receipt = bank.receipt(next);
    expect(receipt).toMatchObject({ version: 3, disposition: 'pooled_public' });
    expect(horseObserverReadsWereIndependent(receipt, next)).toBe(false);
    expect(horseObserverReadsUsedPublicPool(receipt, next)).toBe(true);
    expect(
      horseObserverReadsUsedPublicPool(
        {
          ...receipt,
          pooledPublicProfiles: { ...receipt!.pooledPublicProfiles, availableAtMs: 1001 },
        },
        next
      )
    ).toBe(false);
    bank.clear();
    bank.run(request(other), () => {
      HorseMind.setDecisionScope('holdem:hu', 'nlh', 'cash');
      expect(HorseMind.opponentRead(opponent)).toBeNull();
    });
  });
});

it('carries accepted public notes through the actual worker and HorseLogic read frame', async () => {
  const { workerHarness, requestAt, heroId, opponentId, tableId, otherTableId, lease } =
    await import('../../testing/horseRegression/plan/fixture.js');
  const { HorseLogic } = await import('../HorseLogic.js');
  const { buildHorseDecisionKey } = await import('./protocol.js');
  let consumed = false;
  const h = workerHarness({
    decide: (...args) => {
      const decision = HorseLogic.decide(...args);
      HorseMind.setDecisionScope('holdem:hu', 'nlh', 'cash');
      consumed = HorseMind.opponentRead(opponentId)?.stats.pfr !== undefined;
      return decision;
    },
  });
  try {
    const original = requestAt();
    const done: ObserveCompletedHandRequest = {
      type: 'OBSERVE_COMPLETED_HAND',
      requestId: 700,
      generation: 1000100,
      fence: `${tableId}:1000100:${lease}:observe`,
      handKey: `${tableId}:1000100`,
      committedHandId: committed,
      actions: [
        { userId: opponentId, seat: 2, action: 'raise', amount: 8, stage: 'preflop', timestamp: 1 },
      ],
      bigBlind: 2,
      observerParticipants: {
        version: 1,
        handKey: `${tableId}:1000100:${lease}`,
        status: 'bound',
        contexts: [horseObserverReadContextFromRequest(original)!],
      },
      durableOpponentProfiles: [
        {
          user_id: opponentId,
          variant: 'nlh',
          mode: 'cash',
          size: 'hu',
          observed_hands: 60,
          initialized: true,
          counters: {
            ...freshExploitCounters(),
            hands: 30,
            vpip: 29,
            pfr: 29,
            rfiOpp: 30,
            rfi: 29,
          },
        },
      ],
    };
    h.runtime.receive(done);
    await h.runtime.drain();
    const next = requestAt(701, otherTableId, 1000101);
    next.decisionTimeMs = Date.now() + 10;
    next.decisionKey = buildHorseDecisionKey(next);
    const result = await h.fast(next);
    expect(result.type).toBe('FAST_RESULT');
    expect(consumed).toBe(true);
    const capture = h.captures.at(-1)!;
    expect(capture.observerReads).toMatchObject({ version: 3, disposition: 'pooled_public' });
    expect(horseObserverReadsUsedPublicPool(capture.observerReads, next)).toBe(true);
  } finally {
    await h.close();
  }
});

it('gives 1000 horse views the same public read while keeping private plans individual', () => {
  const bank = new HorseObserverReads(2048, 4096, () => 100);
  bank.complete(shared(), () => {});
  const first = request(actor);
  bank.run(first, () => HorseMind.notePlan('private-hand', actor, true));
  for (let i = 0; i < 1000; i++) {
    const id = `20000000-0000-4000-8000-${(i + 100).toString(16).padStart(12, '0')}`;
    const r = request(id);
    bank.run(r, () => {
      HorseMind.setDecisionScope('holdem:hu', 'nlh', 'cash');
      expect(HorseMind.opponentRead(opponent)?.stats.pfr).toBeDefined();
      expect(HorseMind.getPlan('private-hand', actor)).toBeUndefined();
    });
    expect(bank.receipt(r)?.pooledPublicProfiles?.digest).toBe(
      bank.receipt(first)?.pooledPublicProfiles?.digest
    );
  }
  bank.runIssued(first, () => expect(HorseMind.getPlan('private-hand', actor)).toBe(true));
  expect(HorseMind.getPlan('private-hand', actor)).toBeUndefined();
});
it('bounds profile capacity and refuses malformed action streams without throwing', () => {
  const pool = new PooledPublicProfiles(() => 100, 1);
  expect(pool.observe({ ...shared(), actions: {} as never })).toBe(0);
  expect(pool.observe(shared())).toBe(1);
  const hand = shared();
  hand.generation = 1000002;
  hand.handKey = `${table}:1000002`;
  hand.fence = `${table}:1000002:${lease}:observe`;
  hand.observerParticipants!.handKey = `${table}:1000002:${lease}`;
  hand.actions![0]!.userId = other;
  hand.durableOpponentProfiles![0]!.user_id = other;
  expect(pool.observe(hand)).toBe(1);
  expect(pool.read(request(actor))).toBeNull();
  pool.clear();
  expect(pool.read(request(actor))).toBeNull();
});

it.each(['missing', 'empty', 'unchanged', 'invalid'])(
  'drops stale pooled notes when a newer accepted hand has %s profile evidence',
  (kind) => {
    const pool = new PooledPublicProfiles(() => 100);
    expect(pool.observe(shared())).toBe(1);
    const next = shared();
    next.generation = 1000002;
    next.handKey = `${table}:1000002`;
    next.fence = `${table}:1000002:${lease}:observe`;
    next.observerParticipants!.handKey = `${table}:1000002:${lease}`;
    if (kind === 'missing') delete next.durableOpponentProfiles;
    if (kind === 'empty') next.durableOpponentProfiles = [];
    if (kind === 'invalid') next.durableOpponentProfiles![0]!.counters.pfr = 31;
    expect(pool.observe(next)).toBe(0);
    expect(pool.read(request(other))).toBeNull();
  }
);
