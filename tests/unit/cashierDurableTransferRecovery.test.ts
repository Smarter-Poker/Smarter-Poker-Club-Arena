import { beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  reserveDurableCashierTransfer,
  restoreDurableCashierTransfers,
  updateDurableCashierTransfer,
  clearDurableCashierTransfer,
  type CashierTransferRecovery,
} from '../../src/services/CashierResilience';
const state = vi.hoisted(() => ({ rows: new Map<string, any>(), unavailable: false }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (name: string, args: any) => {
      if (state.unavailable) return { data: null, error: { message: 'Unavailable' } };
      const prefix = `${args.p_actor_id}:${args.p_club_id}:${args.p_kind}:`;
      const key = prefix + args.p_intent_key;
      if (name.endsWith('_reserve')) {
        if (!state.rows.has(key)) state.rows.set(key, structuredClone(args.p_envelope));
        return { data: structuredClone(state.rows.get(key)), error: null };
      }
      if (name.endsWith('_read'))
        return {
          data: [...state.rows.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .map(([, v]) => structuredClone(v)),
          error: null,
        };
      const row = state.rows.get(key);
      const match = row?.submissionId === args.p_identity;
      if (name.endsWith('_ack')) {
        if (match) state.rows.delete(key);
        return { data: match, error: null };
      }
      if (name.endsWith('_update')) {
        if (match) state.rows.set(key, structuredClone(args.p_envelope));
        return { data: match, error: null };
      }
      throw new Error('Unexpected RPC');
    }),
  },
}));
const user = '11111111-1111-4111-8111-111111111111',
  club = '22222222-2222-4222-8222-222222222222',
  target = '33333333-3333-4333-8333-333333333333';
function envelope(n = 4): CashierTransferRecovery {
  return {
    version: 1,
    userId: user,
    clubId: club,
    kind: 'send',
    amount: 10,
    targetIds: [target],
    targetAmounts: { [target]: 10 },
    failures: [{ userId: target, name: 'Private Name', message: 'Private Details' }],
    submissionId: `44444444-4444-4444-8444-44444444444${n}`,
    opIds: { [target]: `55555555-5555-4555-8555-55555555555${n}` },
    source: 'agent_wallet',
    destinations: { [target]: 'player_wallet' },
    createdAt: Date.now(),
  };
}
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  state.rows.clear();
  state.unavailable = false;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});
it('uses one server batch and original per-target keys with a full browser and concurrent tabs', async () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('Full', 'QuotaExceededError');
  });
  const rows = await Promise.all([
    reserveDurableCashierTransfer(envelope(4)),
    reserveDurableCashierTransfer(envelope(5)),
  ]);
  expect(rows[1].submissionId).toBe(rows[0].submissionId);
  expect(rows[1].opIds).toEqual(rows[0].opIds);
  expect(localStorage.length).toBe(0);
  expect(JSON.stringify([...state.rows.values()])).not.toContain('Private Name');
  const restored = await restoreDurableCashierTransfers(user, club);
  expect(restored).toEqual([rows[0]]);
});
it('keeps unknown original identities on server failure and separates changed amounts', async () => {
  const row = await reserveDurableCashierTransfer(envelope());
  state.unavailable = true;
  await updateDurableCashierTransfer(row);
  await clearDurableCashierTransfer(row);
  expect(state.rows.size).toBe(1);
  await expect(
    reserveDurableCashierTransfer({ ...envelope(5), amount: 11, targetAmounts: { [target]: 11 } })
  ).rejects.toBeTruthy();
  state.unavailable = false;
  const next = await reserveDurableCashierTransfer({
    ...envelope(5),
    amount: 11,
    targetAmounts: { [target]: 11 },
  });
  expect(next.submissionId).not.toBe(row.submissionId);
  expect(state.rows.size).toBe(2);
});
it('compare-ack cannot remove a concurrent original batch with a different identity', async () => {
  const row = await reserveDurableCashierTransfer(envelope());
  await clearDurableCashierTransfer({ ...row, submissionId: envelope(5).submissionId });
  expect(state.rows.size).toBe(1);
  await clearDurableCashierTransfer(row);
  expect(state.rows.size).toBe(0);
});

it('restores original batch keys while browser reads and writes throw SecurityError', async () => {
  const original = await reserveDurableCashierTransfer(envelope());
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
    throw new DOMException('Disabled', 'SecurityError');
  });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('Disabled', 'SecurityError');
  });
  const restored = await reserveDurableCashierTransfer(envelope(5));
  expect(restored.submissionId).toBe(original.submissionId);
  expect(restored.opIds).toEqual(original.opIds);
});
