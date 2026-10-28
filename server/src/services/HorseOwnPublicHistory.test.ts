import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  rpc: vi.fn(),
  abort: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  inIds: vi.fn(),
  limit: vi.fn(),
  categoryAbort: vi.fn(),
  response: { data: null, error: null } as any,
}));
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: fixture.rpc, from: fixture.from } }));
import {
  readHorseOwnPublicHistory,
  HORSE_OWN_PUBLIC_HISTORY_DEFINITION_MD5,
} from './HorseOwnPublicHistory.js';
import type { HorseObserverReadContext } from '../engine/HorseObserverReadContext.js';
const context: HorseObserverReadContext = {
  version: 1,
  observerId: '11111111-1111-4111-8111-111111111111',
  variant: 'nlh',
  format: 'cash',
  dealtCount: 2,
};
beforeEach(() => {
  fixture.rpc.mockReset();
  fixture.from.mockReset().mockReturnValue({ select: fixture.select });
  fixture.select.mockReset().mockReturnValue({ in: fixture.inIds });
  fixture.inIds.mockReset().mockReturnValue({ limit: fixture.limit });
  fixture.limit.mockReset().mockReturnValue({ abortSignal: fixture.categoryAbort });
  fixture.categoryAbort.mockReset().mockResolvedValue({ data: [], error: null });
  fixture.abort.mockReset();
  fixture.rpc.mockReturnValue({ abortSignal: fixture.abort });
  fixture.abort.mockImplementation(async () => fixture.response);
  fixture.response = {
    data: {
      definitionMd5: HORSE_OWN_PUBLIC_HISTORY_DEFINITION_MD5,
      window: { version: 1, source: 'original_dealt_public_v1', context, capped: false, hands: [] },
    },
    error: null,
  };
});
it('uses only the pinned individual public reader and original context, with a finite read deadline', async () => {
  expect(await readHorseOwnPublicHistory(context)).toEqual(fixture.response.data.window);
  expect(fixture.rpc).toHaveBeenCalledWith('fn_horse_own_public_history_read_v3', {
    p_observer: context.observerId,
    p_variant: 'nlh',
    p_format: 'cash',
    p_dealt_count: 2,
    p_before: expect.any(String),
  });
  expect(fixture.abort.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
});
it.each(['definition', 'other_observer', 'format', 'extra', 'error', 'throw', 'empty'] as const)(
  'refuses %s rather than importing pooled or unknown history',
  async (fault) => {
    if (fault === 'definition') fixture.response.data.definitionMd5 = '0'.repeat(32);
    if (fault === 'other_observer')
      fixture.response.data.window.context = {
        ...context,
        observerId: '22222222-2222-4222-8222-222222222222',
      };
    if (fault === 'format') fixture.response.data.window.context = { ...context, format: 'mtt' };
    if (fault === 'extra') fixture.response.data.foreign = 'unknown';
    if (fault === 'error') fixture.response.error = { message: 'unavailable' };
    if (fault === 'throw') fixture.abort.mockRejectedValueOnce(Error('unavailable'));
    if (fault === 'empty') fixture.response.data = null;
    expect(await readHorseOwnPublicHistory(context)).toBeNull();
  }
);
it('never asks the provider for an invalid individual context', async () => {
  expect(await readHorseOwnPublicHistory({ ...context, observerId: 'unknown' })).toBeNull();
  expect(fixture.rpc).not.toHaveBeenCalled();
});
it('waits the measured non-blocking deadline, not the old 1.5 s that gave up on answered reads', async () => {
  const { HORSE_OWN_PUBLIC_HISTORY_TIMEOUT_MS } = await import('./HorseOwnPublicHistory.js');
  expect(HORSE_OWN_PUBLIC_HISTORY_TIMEOUT_MS).toBe(5_000);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  await readHorseOwnPublicHistory(context);
  expect(timeout).toHaveBeenCalledWith(5_000);
  timeout.mockRestore();
});
it.each([
  ['error', 'horse_observer_history_error'],
  ['empty', 'horse_observer_history_empty_response'],
  ['throw', 'horse_observer_history_thrown'],
] as const)('names how a %s load failed beside the unavailable count', async (fault, named) => {
  const telemetry = await import('../engine/BrainTelemetry.js');
  telemetry.enableBrainTelemetry();
  telemetry.drainFires();
  if (fault === 'error') fixture.response.error = { message: 'unavailable' };
  if (fault === 'empty') fixture.response.data = null;
  if (fault === 'throw') fixture.abort.mockRejectedValueOnce(Error('unavailable'));
  expect(await readHorseOwnPublicHistory(context)).toBeNull();
  const fired = new Map(telemetry.drainFires().map((f) => [f.feature, f.fires]));
  expect(fired.get('horse_observer_history_unavailable')).toBe(1);
  expect(fired.get(named)).toBe(1);
});

const handId = '55555555-5555-4555-8555-555555555555';
const callerId = '22222222-2222-4222-8222-222222222222';
function withCalledHand() {
  const hand = {
    handId,
    tableId: '33333333-3333-4333-8333-333333333333',
    handNumber: 1000001,
    observerId: context.observerId,
    observerSeat: 1,
    position: 'BTN',
    playersDealt: 2,
    variant: 'nlh',
    format: 'cash',
    playedAtMs: 100,
    bigBlind: 2,
    actions: [
      {
        userId: context.observerId,
        seat: 1,
        action: 'bet',
        amount: 10,
        stage: 'river',
        timestamp: 1,
      },
      { userId: callerId, seat: 2, action: 'call', amount: 10, stage: 'river', timestamp: 2 },
    ],
    results: null,
  };
  fixture.response.data.window.hands = [hand];
  const row = {
    id: handId,
    game_variant: 'nlh',
    community_cards2: null,
    community_cards3: null,
    rit_boards: null,
    showdown: [{ user_id: callerId, mucked: false, hand_name: 'Pair', hole_cards: ['SECRET'] }],
  };
  fixture.categoryAbort.mockResolvedValue({ data: [row], error: null });
  return { hand, row };
}
it('restores public call categories only from validated original participant hands, without cards', async () => {
  withCalledHand();
  const result: any = await readHorseOwnPublicHistory(context);
  expect(result.hands[0].riverCalls).toEqual([{ userId: callerId, weak: true }]);
  expect(fixture.from).toHaveBeenCalledWith('hand_history');
  expect(fixture.inIds).toHaveBeenCalledWith('id', [handId]);
  expect(fixture.limit).toHaveBeenCalledWith(64);
  expect(fixture.categoryAbort.mock.calls[0][0]).toBe(fixture.abort.mock.calls[0][0]);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|hole_cards|showdown|hand_name/);
  expect(fixture.response.data.window.hands[0]).not.toHaveProperty('riverCalls');
});
it.each([
  'mucked',
  'multi_board',
  'rit',
  'unknown_category',
  'other_hand',
  'query_error',
  'invalid_participation',
])('never fabricates restart call evidence for %s', async (fault) => {
  const { row, hand } = withCalledHand();
  if (fault === 'mucked') row.showdown[0].mucked = true;
  if (fault === 'rit') (row as any).rit_boards = [['Ah'], ['Kh']];
  if (fault === 'multi_board') (row as any).community_cards2 = ['Ah'];
  if (fault === 'unknown_category') row.showdown[0].hand_name = '';
  if (fault === 'other_hand') row.id = callerId;
  if (fault === 'query_error')
    fixture.categoryAbort.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
  if (fault === 'invalid_participation') hand.observerId = callerId;
  const result: any = await readHorseOwnPublicHistory(context);
  if (fault === 'invalid_participation') {
    expect(result).toBeNull();
    expect(fixture.from).not.toHaveBeenCalled();
  } else if (fault === 'other_hand' || fault === 'query_error') {
    expect(result.hands[0]).not.toHaveProperty('riverCalls');
  } else expect(result.hands[0].riverCalls).toEqual([]);
});

it.each(['missing', 'stale', 'throw', 'captured'] as const)(
  'uses one bound sidecar in the existing load deadline and preserves original history for %s',
  async (mode) => {
    const { hand } = withCalledHand();
    const multi = { ...context, dealtCount: 3 };
    hand.playersDealt = 3;
    fixture.response.data.window.context = multi;
    // A third participant is public and folded before the two-player river.
    hand.actions.unshift({
      userId: '44444444-4444-4444-8444-444444444444',
      seat: 3,
      action: 'fold',
      amount: 0,
      stage: 'preflop',
      timestamp: 0,
    });
    fixture.categoryAbort.mockResolvedValue({ data: [], error: null });
    const base = structuredClone(fixture.response.data.window);
    const second = vi.fn(async (_signal: AbortSignal) => {
      if (mode === 'throw') throw Error('missing RPC');
      if (mode === 'missing') return { data: null, error: { message: 'missing RPC' } };
      const { HORSE_RIVER_NODE_DEFINITION_MD5, riverNodeBindings } =
        await import('../engine/horseDecision/riverNodeSidecar.js');
      return {
        error: null,
        data: {
          version: 1,
          status: 'captured',
          definitionMd5: mode === 'stale' ? '0'.repeat(32) : HORSE_RIVER_NODE_DEFINITION_MD5,
          hands: riverNodeBindings(base).map((b) => ({
            handId: b.handId,
            binding: b.binding,
            status: 'unavailable',
            reason: 'incomplete_or_bounded_nodes',
          })),
        },
      };
    });
    fixture.rpc.mockImplementation((name) => ({
      abortSignal: name === 'fn_horse_own_public_history_read_v3' ? fixture.abort : second,
    }));
    const result: any = await readHorseOwnPublicHistory(multi);
    expect(fixture.rpc).toHaveBeenCalledTimes(2);
    const original = fixture.rpc.mock.calls[0][1],
      enriched = fixture.rpc.mock.calls[1][1];
    expect(enriched).toMatchObject({
      p_observer: original.p_observer,
      p_variant: original.p_variant,
      p_dealt_count: 3,
      p_before: original.p_before,
    });
    expect(second.mock.calls[0][0]).toBe(fixture.abort.mock.calls[0][0]);
    expect(result.hands[0].actions).toEqual(base.hands[0].actions);
    expect(result.hands[0].riverNodeEvidence).toBe(mode === 'captured' ? 'unavailable' : undefined);
    expect(fixture.response.data.window).toEqual(base);
  }
);
