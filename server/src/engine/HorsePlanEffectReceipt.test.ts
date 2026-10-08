import { describe, expect, it } from 'vitest';
import {
  createHorsePlanEffectReceipt,
  horsePlanAcceptanceFromController,
  horsePlanAcceptanceIsValid,
  horsePlanEffectReceiptIsValid,
  horsePlanIssuedBatchDigest,
  reconstructHorsePlanEffects,
  type HorsePlanEffectReceipt,
} from './HorsePlanEffectReceipt.js';
import { horsePlanBatchBindingFromRequest, horsePlanContextKey } from './HorsePlanHandIdentity.js';
import type { HorseMindDecisionEffect } from './HorseMind.js';
import { requestAt, tableId, lease, heroId } from '../testing/horseRegression/plan/fixture.js';

const epoch = '99999999-9999-4999-8999-999999999999';
function receiptAt(hand = 1000100, disposition: 'applied' | 'failed' = 'applied') {
  const request = requestAt(1, tableId, hand);
  const binding = horsePlanBatchBindingFromRequest(request);
  const handKey = horsePlanContextKey(binding.planContext)!;
  const effects: HorseMindDecisionEffect[] = [
    { type: 'plan', handKey, userId: heroId, barrelIntent: true },
    { type: 'raise_plan', handKey, userId: heroId, street: 'flop', plan: 'callOnce' },
  ];
  return createHorsePlanEffectReceipt({
    binding,
    effects,
    issuedAction: { action: 'bet', amount: 6 },
    acceptance: horsePlanAcceptanceFromController(
      { action: 'bet', amount: 6 },
      { action: 'bet', amount: 6 },
      { requestId: binding.fastRequestId, decisionKey: binding.decisionKey }
    ),
    policy: { graph: 'horse-policy-order-v1', candidates: [] },
    sourceRelease: null,
    workerEpoch: epoch,
    disposition,
  });
}
const sameLive = (hand = 1000100) => ({
  live: (table: string) =>
    table === tableId
      ? { tableId, handNumber: hand, lease, street: 'flop', generation: 100 }
      : null,
  policyUsable: () => true,
});

describe('HorsePlanEffectReceipt', () => {
  it('digests the original issued batch canonically, independent of object key order', () => {
    const receipt = receiptAt();
    const reordered = receipt.effects.map((effect) =>
      Object.fromEntries(Object.entries(effect).reverse())
    );
    expect(horsePlanIssuedBatchDigest(receipt.binding, reordered)).toBe(receipt.issuedBatchDigest);
    expect(receipt.issuedBatchDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(horsePlanIssuedBatchDigest(receipt.binding, [])).not.toBe(receipt.issuedBatchDigest);
    expect(horsePlanIssuedBatchDigest({ ...receipt.binding, seat: 0 }, receipt.effects)).toBeNull();
  });

  it('refuses forged digests, unbound effects, unbound acceptance and unknown fields', () => {
    const base = structuredClone(receiptAt()) as any;
    expect(horsePlanEffectReceiptIsValid(base)).toBe(true);
    const forged = [
      { ...base, issuedBatchDigest: 'f'.repeat(64) },
      { ...base, effects: [{ ...base.effects[0], userId: 'someone-else' }, base.effects[1]] },
      { ...base, effects: [{ ...base.effects[0], barrelIntent: false }, base.effects[1]] },
      { ...base, effects: [] },
      { ...base, acceptance: { ...base.acceptance, witness: { requestId: 2, decisionKey: 'x' } } },
      { ...base, acceptance: { ...base.acceptance, action: 'call' } },
      { ...base, workerEpoch: 'not-an-epoch' },
      { ...base, disposition: 'applied_volatile' },
      { ...base, sourceRelease: 'main' },
      { ...base, extra: true },
    ];
    for (const value of forged) expect(horsePlanEffectReceiptIsValid(value)).toBe(false);
    expect(horsePlanAcceptanceIsValid(base.acceptance, base.binding)).toBe(true);
    expect(horsePlanAcceptanceIsValid({ ...base.acceptance, amount: Number.NaN })).toBe(false);
    expect(() =>
      createHorsePlanEffectReceipt({ ...base, effects: [{ ...base.effects[0], handKey: 'x' }] })
    ).toThrow('invalid');
  });

  it('reconstructs only the live hand, in deterministic order, and refuses everything else by name', () => {
    const live = receiptAt(1000100);
    const other = receiptAt(1000099);
    const failed = receiptAt(1000100, 'failed');
    const recovery = reconstructHorsePlanEffects([other, live, {}, failed], sameLive());
    expect(recovery.outcomes).toEqual(['hand_superseded', 'conflict', 'invalid', 'conflict']);
    const clean = reconstructHorsePlanEffects([other, live], sameLive());
    expect(clean.outcomes).toEqual(['hand_superseded', 'replaced']);
    expect(clean.replaced).toEqual([live]);
    expect(reconstructHorsePlanEffects([failed], sameLive()).outcomes).toEqual([
      'failed_not_replayed',
    ]);
    expect(
      reconstructHorsePlanEffects([live], { ...sameLive(), policyUsable: () => false }).outcomes
    ).toEqual(['replaced']);
  });

  it('a fresh process with no live hand of the old lease materializes nothing', () => {
    const receipts: HorsePlanEffectReceipt[] = [receiptAt(1000098), receiptAt(1000100)];
    const fresh = reconstructHorsePlanEffects(receipts, {
      live: () => ({
        tableId,
        handNumber: 1000101,
        lease: '55555555-5555-4555-8555-555555555555',
        street: 'preflop',
        generation: 1,
      }),
      policyUsable: () => true,
    });
    expect(fresh.replaced).toEqual([]);
    expect(fresh.outcomes).toEqual(['hand_superseded', 'hand_superseded']);
    const throwing = reconstructHorsePlanEffects(receipts, {
      live: () => {
        throw Error('unreadable');
      },
      policyUsable: () => true,
    });
    expect(throwing.outcomes).toEqual(['hand_not_live', 'hand_not_live']);
  });
});
