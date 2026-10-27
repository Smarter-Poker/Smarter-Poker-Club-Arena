import { expect, it, vi } from 'vitest';
import {
  HorseOwnPublicHistoryCache,
  makeOwnPublicHistoryPacket,
  ownPublicHistoryIsValid,
} from './ownPublicHistory.js';
import {
  decisionRequest,
  heroId,
  opponentId,
  tableId,
  requestAt,
  lease,
} from '../../testing/horseRegression/plan/fixture.js';
import { HorseObserverReads } from './observerReads.js';
import { HorseMind } from '../HorseMind.js';
import { horsePlanHandKey } from '../HorseDecisionEffects.js';
import { horsePlanContextFromDecision } from '../HorsePlanHandIdentity.js';
import { horseObserverReadContextFromRequest } from '../HorseObserverReadContext.js';
import type { ObserveCompletedHandRequest } from './protocol.js';
import { horseJournalJson } from '../../services/horseDecisionJournal/record.js';

const context = () => horseObserverReadContextFromRequest(decisionRequest())!;
const window = () => ({
  version: 1 as const,
  source: 'original_dealt_public_v1' as const,
  context: context(),
  capped: false,
  hands: [
    {
      handId: '55555555-5555-4555-8555-555555555555',
      tableId,
      handNumber: 1000001,
      observerId: heroId,
      observerSeat: 1,
      position: 'BTN',
      playersDealt: 2,
      variant: 'nlh',
      format: 'cash',
      playedAtMs: 100,
      bigBlind: 2,
      actions: [
        {
          seat: 1,
          userId: heroId,
          action: 'raise',
          amount: 6,
          stage: 'preflop',
          timestamp: 10,
          isFullRaise: true,
        },
        { seat: 2, userId: opponentId, action: 'fold', amount: 0, stage: 'preflop', timestamp: 20 },
      ],
      results: [
        { user_id: heroId, net: 2 },
        { user_id: opponentId, net: -2 },
      ],
    },
  ],
});
it('makes an explicit bounded public window, with no cards or pooled profile fields', () => {
  const packet = makeOwnPublicHistoryPacket(window(), 200)!;
  expect(ownPublicHistoryIsValid(packet, context(), 200)).toBe(true);
  expect(packet.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(packet)).not.toMatch(/cards|showdown|hole_cards|donor|counters/);
});
it('retains its digest through the actual journal key ordering without accepting changed content', () => {
  const packet = makeOwnPublicHistoryPacket(window(), 200)!;
  const retained = JSON.parse(horseJournalJson(packet));
  expect(ownPublicHistoryIsValid(retained, context(), 200)).toBe(true);
  retained.hands[0].actions[0].amount++;
  expect(ownPublicHistoryIsValid(retained, context(), 200)).toBe(false);
});
it.each([
  'observer',
  'variant',
  'format',
  'count',
  'unknown_position',
  'nonparticipant',
  'cards',
  'future_hand',
  'duplicate',
  'oversized',
])('refuses a %s history instead of repairing or pooling it', (fault) => {
  const source: any = window();
  if (fault === 'observer') source.context = { ...source.context, observerId: opponentId };
  if (fault === 'variant') source.hands[0].variant = 'plo5';
  if (fault === 'format') source.hands[0].format = 'mtt';
  if (fault === 'count') source.hands[0].playersDealt = 6;
  if (fault === 'unknown_position') source.hands[0].position = 'UNKNOWN';
  if (fault === 'nonparticipant') source.hands[0].observerId = opponentId;
  if (fault === 'cards') source.hands[0].actions[0].cards = ['Ah', 'Kh'];
  if (fault === 'future_hand') source.hands[0].playedAtMs = 201;
  if (fault === 'duplicate') source.hands.push(structuredClone(source.hands[0]));
  if (fault === 'oversized') source.hands = Array.from({ length: 65 }, () => source.hands[0]);
  expect(makeOwnPublicHistoryPacket(source, 200)).toBeNull();
});
it('binds the context, exact available time and bytes and refuses a later public response for an older snapshot', () => {
  const packet = makeOwnPublicHistoryPacket(window(), 200)!;
  expect(ownPublicHistoryIsValid(packet, context(), 199)).toBe(false);
  expect(ownPublicHistoryIsValid(packet, { ...context(), observerId: opponentId }, 201)).toBe(
    false
  );
  const changed = structuredClone(packet);
  changed.hands[0].actions[0].amount++;
  expect(ownPublicHistoryIsValid(changed, context(), 201)).toBe(false);
});
it('loads only on the actual request, shares no contexts, never waits on the turn, and labels availability after response', async () => {
  let resolve!: (v: unknown) => void;
  const load = vi.fn(
    () =>
      new Promise<unknown>((r) => {
        resolve = r;
      })
  );
  let now = 100;
  const cache = new HorseOwnPublicHistoryCache(load, () => now);
  expect(cache.forSnapshot(context(), 100)).toBeUndefined();
  expect(cache.forSnapshot(context(), 101)).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(1);
  now = 200;
  resolve(window());
  await Promise.resolve();
  await Promise.resolve();
  expect(cache.forSnapshot(context(), 199)).toBeUndefined();
  const packet = cache.forSnapshot(context(), 200)!;
  expect(packet.availableAtMs).toBe(200);
  cache.acknowledge(context(), packet.digest);
  expect(cache.forSnapshot(context(), 201)).toBeUndefined();
  cache.acknowledge(context(), null); // an evicted/restarted worker needs the original window again
  expect(cache.forSnapshot(context(), 202)?.digest).toBe(packet.digest);
  expect(cache.forSnapshot({ ...context(), observerId: opponentId }, 202)).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(2);
});
it('keeps failed or unavailable history explicit and does not start a retry timer or another request', async () => {
  const load = vi.fn(async () => {
    throw Error('unavailable');
  });
  const cache = new HorseOwnPublicHistoryCache(load, () => 200);
  expect(cache.forSnapshot(context(), 200)).toBeUndefined();
  await Promise.resolve();
  await Promise.resolve();
  expect(cache.forSnapshot(context(), 300)).toBeUndefined();
  expect(load).toHaveBeenCalledTimes(1);
});
it.each(['synchronous', 'rejected', 'response_processing'] as const)(
  'settles a %s failure without an unhandled rejection or exhausted request capacity',
  async (failure) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const load = vi.fn(() => {
        if (failure === 'synchronous') throw Error('synchronous provider failure');
        return failure === 'rejected'
          ? Promise.reject(Error('provider rejection'))
          : Promise.resolve(window());
      });
      const cache = new HorseOwnPublicHistoryCache(load, () => {
        if (failure === 'response_processing') throw Error('response processing failed');
        return 200;
      });
      expect(cache.forSnapshot(context(), 200)).toBeUndefined();
      // Drain this actual request's promise chain, without a timer or retry.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cache.state(context())).toBe('unavailable');
      expect(cache.forSnapshot(context(), 300)).toBeUndefined();
      expect(load).toHaveBeenCalledTimes(1);
    }
    const next = new HorseOwnPublicHistoryCache(
      async () => window(),
      () => 200
    );
    expect(next.forSnapshot(context(), 200)).toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(next.state(context())).toBe('available');
    expect(next.forSnapshot(context(), 201)).toMatchObject({ availableAtMs: 200 });
  }
);
it('preserves the original accepted plan while historical observations are installed', () => {
  const bank = new HorseObserverReads(2048, 4096, () => 50);
  const request = decisionRequest();
  request.ownPublicHistoryState = 'pending';
  const key = horsePlanHandKey(
    request.gameState.actionHistory,
    horsePlanContextFromDecision(request)
  )!;
  bank.run(request, () => {});
  bank.runIssued(request, () => HorseMind.notePlan(key, heroId, true));
  const next = {
    ...request,
    requestId: request.requestId + 1,
    decisionTimeMs: request.decisionTimeMs + 1,
    ownPublicHistory: makeOwnPublicHistoryPacket(window(), 200)!,
  };
  bank.run(next, () => {
    expect(HorseMind.getPlan(key, heroId)).toBe(true);
    expect(HorseMind.getStats(opponentId)).toMatchObject({ hands: 1, folds: 1 });
  });
  expect(bank.receipt(next)).toMatchObject({ version: 2, history: 'own_public_window' });
  expect(HorseMind.getPlan(key, heroId)).toBeUndefined();
  HorseMind.reset();
});
it('does not let a transport caller mutate the cached public window', async () => {
  const cache = new HorseOwnPublicHistoryCache(
    async () => window(),
    () => 200
  );
  cache.forSnapshot(context(), 200);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const returned = cache.forSnapshot(context(), 201)!;
  returned.hands[0].actions[0].amount = 999;
  expect(cache.forSnapshot(context(), 201)!.hands[0].actions[0].amount).toBe(6);
});

it('restores river-call evidence after restart only inside the original observer window, once per hand', () => {
  const source: any = window();
  source.hands = Array.from({ length: 12 }, (_, i) => ({
    ...structuredClone(window().hands[0]),
    handId: `55555555-5555-4555-8555-${String(i + 1).padStart(12, '0')}`,
    handNumber: 1000001 + i,
    playedAtMs: 100 + i,
    actions: [
      { seat: 1, userId: heroId, action: 'bet', amount: 10, stage: 'river', timestamp: 1 },
      { seat: 2, userId: opponentId, action: 'call', amount: 10, stage: 'river', timestamp: 2 },
    ],
    riverCalls: [{ userId: opponentId, weak: true }],
  }));
  const packet = makeOwnPublicHistoryPacket(source, 200)!;
  expect(packet).not.toBeNull();
  expect(JSON.stringify(packet)).not.toMatch(/cards|showdown|hand_name|pooled/);
  for (let restart = 0; restart < 2; restart++) {
    HorseMind.reset();
    const bank = new HorseObserverReads(2048, 4096, () => 50);
    const first = { ...decisionRequest(), ownPublicHistoryState: 'pending' as const };
    bank.run(first, () => undefined);
    const restored = { ...first, requestId: first.requestId + 1, ownPublicHistory: packet };
    for (let duplicate = 0; duplicate < 2; duplicate++)
      bank.run(restored, () => {
        expect(HorseMind.getScopedStats(opponentId, 'holdem:hu')).toMatchObject({
          riverCallSD: 12,
          riverCallSDWeak: 12,
        });
        HorseMind.setDecisionScope('holdem:hu', 'nlh');
        expect(HorseMind.riverCallLightTendency(opponentId, 0.4)).toBe(1);
      });
    expect(HorseMind.getStats(opponentId)).toBeUndefined();
  }
  HorseMind.reset();
});
it.each(
  (['missing', 'empty', 'present'] as const).flatMap((categories) =>
    (['pending', 'unavailable'] as const).map((historyState) => ({ categories, historyState }))
  )
)(
  'keeps live showdown evidence with $categories categories after $historyState history, without counting twice',
  ({ categories, historyState }) => {
    HorseMind.reset();
    const source: any = window();
    const hand = source.hands[0];
    hand.handNumber = 1000100;
    hand.actions = [
      { seat: 1, userId: heroId, action: 'bet', amount: 10, stage: 'river', timestamp: 1 },
      { seat: 2, userId: opponentId, action: 'call', amount: 10, stage: 'river', timestamp: 2 },
    ];
    if (categories !== 'missing')
      hand.riverCalls = categories === 'empty' ? [] : [{ userId: opponentId, weak: true }];
    const packet = makeOwnPublicHistoryPacket(source, 200)!;
    expect(packet).not.toBeNull();
    const bank = new HorseObserverReads(2048, 4096, () => 50);
    const first = { ...decisionRequest(), ownPublicHistoryState: historyState };
    bank.run(first, () => undefined);
    const live: ObserveCompletedHandRequest = {
      type: 'OBSERVE_COMPLETED_HAND',
      requestId: 101,
      generation: hand.handNumber,
      fence: `${tableId}:${hand.handNumber}:${first.fence.split(':')[3]}:observe`,
      handKey: `${tableId}:${hand.handNumber}`,
      committedHandId: hand.handId,
      bigBlind: hand.bigBlind,
      actions: hand.actions,
      results: hand.results,
      riverCallContext: { variant: 'nlh', boardCount: 1 },
      showdown: [{ user_id: opponentId, mucked: false, hand_name: 'Pair' }],
    };
    expect(bank.complete(live, () => undefined)).toBe(1);
    const restored = {
      ...first,
      requestId: first.requestId + 1,
      decisionTimeMs: first.decisionTimeMs + 1,
      ownPublicHistory: packet,
    };
    for (let duplicate = 0; duplicate < 2; duplicate++)
      bank.run(restored, () => {
        expect(HorseMind.getScopedStats(opponentId, 'holdem:hu')).toMatchObject({
          hands: 1,
          riverCallSD: 1,
          riverCallSDWeak: 1,
        });
      });
    expect(bank.complete(live, () => undefined)).toBe(0);
    expect(HorseMind.getStats(opponentId)).toBeUndefined();
    HorseMind.reset();
  }
);
it.each(['duplicate', 'other_actor', 'extra', 'wrong_type', 'not_called'])(
  'refuses malformed retained public river evidence: %s',
  (fault) => {
    const source: any = window();
    source.hands[0].actions[1] = {
      seat: 2,
      userId: opponentId,
      action: 'call',
      amount: 10,
      stage: 'river',
      timestamp: 2,
    };
    source.hands[0].riverCalls = [{ userId: opponentId, weak: true }];
    const sample = source.hands[0].riverCalls[0];
    if (fault === 'duplicate') source.hands[0].riverCalls.push({ ...sample });
    if (fault === 'other_actor') sample.userId = heroId;
    if (fault === 'extra') sample.cards = ['Ah'];
    if (fault === 'wrong_type') sample.weak = 'true';
    if (fault === 'not_called') source.hands[0].actions[1].action = 'fold';
    expect(makeOwnPublicHistoryPacket(source, 200)).toBeNull();
  }
);

it('recovers a failed context only on a later real request after cooldown, with coalescing and no timer', async () => {
  let now = 100;
  let resolve!: (v: unknown) => void;
  const load = vi
    .fn()
    .mockRejectedValueOnce(Error('temporary'))
    .mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
  const cache = new HorseOwnPublicHistoryCache(load, () => now);
  cache.forSnapshot(context(), 100);
  await new Promise<void>((r) => setImmediate(r));
  expect(cache.state(context())).toBe('unavailable');
  now = 60_099;
  cache.forSnapshot(context(), now);
  expect(load).toHaveBeenCalledTimes(1);
  now = 60_100;
  cache.forSnapshot(context(), now);
  cache.forSnapshot(context(), now + 1);
  expect(load).toHaveBeenCalledTimes(2);
  expect(cache.state(context())).toBe('pending');
  resolve(window());
  await new Promise<void>((r) => setImmediate(r));
  expect(cache.forSnapshot(context(), now)).toMatchObject({ availableAtMs: now });
  expect(cache.forSnapshot({ ...context(), observerId: opponentId }, now)).toBeUndefined();
});

it('bounds a long failed-load tail and explicitly caps recovered evidence while preserving issued plans', () => {
  const bank = new HorseObserverReads(2048, 4096, () => 200);
  const source = window();
  for (let i = 0; i < 65; i++) {
    const handNumber = 1000200 + i;
    const r = {
      ...requestAt(i + 1, tableId, handNumber),
      ownPublicHistoryState: 'pending' as const,
    };
    bank.run(r, () => undefined);
    bank.complete(
      {
        type: 'OBSERVE_COMPLETED_HAND',
        requestId: 1000 + i,
        generation: handNumber,
        fence: `${tableId}:${handNumber}:${lease}:observe`,
        handKey: `${tableId}:${handNumber}`,
        committedHandId: `77777777-7777-4777-8777-${String(i + 1).padStart(12, '0')}`,
        bigBlind: 2,
        actions: source.hands[0].actions,
        showdown: null,
      },
      () => undefined
    );
  }
  const recovered = {
    ...requestAt(2000, tableId, 1000300),
    ownPublicHistory: makeOwnPublicHistoryPacket(source, 200)!,
  };
  bank.run(recovered, () => {
    expect(HorseMind.getStats(opponentId)?.hands).toBe(65);
  });
  expect(bank.receipt(recovered)).toMatchObject({ version: 2, historyCapped: true });
  HorseMind.reset();
});

it('reconstructs only this observer conditional river read after a fresh worker and refuses duplicate history', () => {
  const source = window(),
    base = source.hands[0];
  source.hands = Array.from({ length: 12 }, (_, i) => ({
    ...base,
    handId: `55555555-5555-4555-8555-${String(i + 1).padStart(12, '0')}`,
    handNumber: 1000001 + i,
    position: 'BB',
    playedAtMs: 100 + i,
    actions: [
      {
        seat: 1,
        userId: heroId,
        action: 'check',
        amount: 0,
        stage: 'river',
        timestamp: 10 + i * 2,
        isFullRaise: false,
      },
      {
        seat: 2,
        userId: opponentId,
        action: 'bet',
        amount: 10,
        stage: 'river',
        timestamp: 11 + i * 2,
        isFullRaise: true,
      },
    ],
  }));
  const packet = makeOwnPublicHistoryPacket(source, 200);
  expect(packet).not.toBeNull();
  for (let restart = 0; restart < 2; restart++) {
    const bank = new HorseObserverReads();
    const req = {
      ...decisionRequest(),
      ownPublicHistory: packet!,
      ownPublicHistoryState: 'available' as const,
    };
    for (let replay = 0; replay < 2; replay++)
      bank.run(req, () => {
        expect(HorseMind.getStats(opponentId)).toMatchObject({
          riverLastToActOpps: 12,
          riverLastToActBets: 12,
        });
        expect(HorseMind.riverLastToActRead(opponentId)).toMatchObject({
          opportunities: 12,
          bets: 12,
          rate: 1,
        });
      });
    bank.run(
      { ...decisionRequest(), gameState: { ...decisionRequest().gameState, gameVariant: 'plo5' } },
      () => expect(HorseMind.riverLastToActRead(opponentId)).toBeNull()
    );
  }
});
