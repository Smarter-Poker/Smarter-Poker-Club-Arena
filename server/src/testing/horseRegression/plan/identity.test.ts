import { describe, expect, it } from 'vitest';
import {
  horsePlanContextFromDecision,
  horsePlanContextIsValid,
  horsePlanContextKey,
  horsePlanContextMatchesRequest,
  horsePlanBatchBindingFromRequest,
  horsePlanBatchBindingIsValid,
  horsePlanBatchBindingMatchesRequest,
} from '../../../engine/HorsePlanHandIdentity.js';
import {
  horsePlanHandKey,
  horseMindHandKey,
  horseDecisionEffectsMatchRequest,
  horseDecisionEffectsKey,
} from '../../../engine/HorseDecisionEffects.js';
import { requestAt, otherTableId } from './fixture.js';

describe('allocated plan identity and independent request joins', () => {
  it('separates two actual table coordinates sharing the same player, action and clock', () => {
    const a = requestAt(),
      b = requestAt(2, otherTableId);
    expect(a.gameState.actionHistory).toEqual(b.gameState.actionHistory);
    expect(horseMindHandKey(a.gameState.actionHistory)).toBe(
      horseMindHandKey(b.gameState.actionHistory)
    );
    expect(horsePlanContextKey(horsePlanContextFromDecision(a))).not.toBe(
      horsePlanContextKey(horsePlanContextFromDecision(b))
    );
    expect(horsePlanContextMatchesRequest(horsePlanContextFromDecision(a), b)).toBe(false);
  });
  it('keeps the hand namespace across actual turn, lease and actor changes', () => {
    const a = requestAt(),
      b = requestAt(2);
    b.player.seat = 2;
    b.generation = 101;
    b.fence = b.fence.replace(
      ':1:44444444-4444-4444-8444-444444444444:100',
      ':2:55555555-5555-4555-8555-555555555555:101'
    );
    expect(horsePlanContextKey(horsePlanContextFromDecision(a))).toBe(
      horsePlanContextKey(horsePlanContextFromDecision(b))
    );
  });
  it.each([
    null,
    undefined,
    [],
    {},
    { version: '1', hand: null },
    { version: 1 },
    { version: 1, hand: null, extra: true },
    Object.assign(Object.create({ version: 1 }), { hand: null }),
    { version: 1, hand: { version: 1, tableId: 'x', handNumber: 1000000 } },
    { version: 1, hand: { version: 1, tableId: otherTableId, handNumber: 999999 } },
    {
      version: 1,
      hand: { version: 1, tableId: otherTableId, handNumber: Number.MAX_SAFE_INTEGER + 1 },
    },
    { version: 1, hand: { version: 1, tableId: otherTableId, handNumber: '1000000' } },
  ])('refuses malformed context without repairing it: %j', (value) => {
    expect(horsePlanContextIsValid(value)).toBe(false);
    expect(horsePlanContextKey(value)).toBeNull();
  });
  it.each([
    'legacy:hand:turn',
    '33333333-3333-4333-8333-333333333333:999999:1:1:100',
    '33333333-3333-4333-8333-333333333333:9007199254740993:1:1:100',
    '33333333-3333-4333-8333-333333333333:1000100:2:1:100',
  ])('keeps missing or mismatched producer identity unavailable: %s', (fence) => {
    const request = requestAt();
    request.fence = fence;
    const context = horsePlanContextFromDecision(request);
    expect(context).toEqual({ version: 1, hand: null });
    expect(horsePlanHandKey(request.gameState.actionHistory, context)).toBeNull();
    expect(horsePlanHandKey(request.gameState.actionHistory)).not.toBeNull();
  });
  it('preserves the empty-history gate and detaches the admitted context', () => {
    const request = requestAt(),
      context = horsePlanContextFromDecision(request);
    expect(horsePlanHandKey([], context)).toBeNull();
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.hand)).toBe(true);
    const key = horsePlanContextKey(context);
    request.fence = 'changed';
    expect(horsePlanContextKey(context)).toBe(key);
  });
  it.each([
    'fastRequestId',
    'generation',
    'fence',
    'decisionKey',
    'actorId',
    'seat',
    'street',
    'planContext',
  ] as const)('rejects a changed original %s join', (field) => {
    const request = requestAt(),
      binding = structuredClone(horsePlanBatchBindingFromRequest(request));
    const changes = {
      fastRequestId: 2,
      generation: 101,
      fence: requestAt(2, otherTableId).fence,
      decisionKey: 'phase5-v1:' + 'a'.repeat(64),
      actorId: 'another',
      seat: 2,
      street: 'turn',
      planContext: { version: 1, hand: null },
    };
    (binding as any)[field] = changes[field];
    expect(horsePlanBatchBindingMatchesRequest(binding, request)).toBe(false);
  });
  it.each([
    [],
    {},
    null,
    Object.assign(Object.create({ version: 'horse-plan-batch-v1' }), { extra: true }),
  ])('does not coerce a malformed batch envelope: %j', (value) =>
    expect(horsePlanBatchBindingIsValid(value)).toBe(false)
  );
  it('binds plan, raise-response and outlook records while preserving historical batch shape', () => {
    const request = requestAt(),
      planContext = horsePlanContextFromDecision(request),
      handKey = horsePlanHandKey(request.gameState.actionHistory, planContext)!;
    const effects = [
      { type: 'plan', handKey, userId: request.player.user_id, barrelIntent: true },
      {
        type: 'raise_plan',
        handKey,
        userId: request.player.user_id,
        street: 'flop',
        plan: 'callOnce',
      },
      {
        type: 'outlook',
        handKey,
        userId: request.player.user_id,
        street: 'flop',
        good: ['Ah'],
        scare: ['Ks'],
      },
    ];
    const match = {
      userId: request.player.user_id,
      history: request.gameState.actionHistory,
      street: 'flop',
      brainFallback: false,
      planContext,
    };
    expect(horseDecisionEffectsMatchRequest(effects, match)).toBe(true);
    expect(
      horseDecisionEffectsMatchRequest(effects, {
        ...match,
        planContext: horsePlanContextFromDecision(requestAt(2, otherTableId)),
      })
    ).toBe(false);
    expect(horseDecisionEffectsMatchRequest(effects, { ...match, brainFallback: true })).toBe(
      false
    );
    const reversed = effects.map((e) => Object.fromEntries(Object.entries(e).reverse()));
    expect(horseDecisionEffectsKey(reversed)).toBe(horseDecisionEffectsKey(effects));
  });
});
