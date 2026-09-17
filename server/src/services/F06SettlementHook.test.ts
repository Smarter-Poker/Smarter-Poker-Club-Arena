import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source = readFileSync(
  new URL('../engine/ServerTableEngineSettlement.ts', import.meta.url),
  'utf8'
);
const start = source.indexOf(
  '          const outcome = await processHandPostCommitObligations(v_handHistoryId);'
);
const end = source.indexOf('          obligationsApplied = true;', start);
// Execute the exact modified success block, not a duplicate implementation.
const block = source.slice(start, end + '          obligationsApplied = true;'.length);
const run = new Function(
  'processHandPostCommitObligations',
  'snap',
  'v_handHistoryId',
  `return (async()=>{let resolvedAddOnCount;let obligationsApplied=false;${block};return {resolvedAddOnCount,obligationsApplied};})()`
);
it('actual success block waits for exact accepted permit callback before advancing', async () => {
  const order: string[] = [];
  const self = {
    f06CurrentPermit: {},
    finishF06AcceptedHand: async (n: string, id: string) => {
      expect(n).toBe('41');
      expect(id).toBe('hand-id');
      order.push('permit');
    },
  };
  const result = await run.call(
    self,
    async () => {
      order.push('postcommit');
      return { ok: true, pending_addons: 2 };
    },
    { handNumber: 41 },
    'hand-id'
  );
  expect(order).toEqual(['postcommit', 'permit']);
  expect(result).toEqual({ resolvedAddOnCount: 2, obligationsApplied: true });
});
it('actual success block propagates permit failure into existing retry path', async () => {
  await expect(
    run.call(
      {
        f06CurrentPermit: {},
        finishF06AcceptedHand: async () => {
          throw new Error('unproven');
        },
      },
      async () => ({ ok: true }),
      { handNumber: 41 },
      'id'
    )
  ).rejects.toThrow('unproven');
});
it('refused postcommit never invokes permit completion', async () => {
  let called = false;
  await expect(
    run.call(
      {
        f06CurrentPermit: {},
        finishF06AcceptedHand: async () => {
          called = true;
        },
      },
      async () => ({ ok: false, reason: 'pending' }),
      { handNumber: 41 },
      'id'
    )
  ).rejects.toThrow('pending');
  expect(called).toBe(false);
});
