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
} from '../../testing/horseRegression/plan/fixture.js';
import { HorseObserverReads } from './observerReads.js';
import { HorseMind } from '../HorseMind.js';
import { horsePlanHandKey } from '../HorseDecisionEffects.js';
import { horsePlanContextFromDecision } from '../HorsePlanHandIdentity.js';
import { horseObserverReadContextFromRequest } from '../HorseObserverReadContext.js';

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
