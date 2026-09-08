import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  assertChipAmount,
  reserveAgentWalletOperation,
  completeAgentWalletOperation,
  confirmedAgentWalletReceipt,
} from '../../src/services/AgentWalletIntent';

const userId = '10000000-0000-4000-8000-000000000001';
const clubId = '20000000-0000-4000-8000-000000000001';
const targetId = '30000000-0000-4000-8000-000000000001';
const intent = { userId, clubId, targetId, kind: 'agent_send' as const, amount: 12.34 };
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  const pending = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (key: string, _options: unknown, fn: () => unknown) => {
        const next = (pending.get(key) || Promise.resolve()).then(fn);
        pending.set(
          key,
          next.catch(() => undefined)
        );
        return next;
      },
    },
  });
});
describe('durable agent wallet intent', () => {
  it.each([0, -1, NaN, Infinity, -Infinity, 0.001, 1e9 + 1])(
    'rejects invalid amount %s',
    (amount) => {
      expect(() => assertChipAmount(amount)).toThrow();
    }
  );
  it.each([0.01, 0.29, 12.34, 1e9])('accepts exact supported amount %s', (amount) => {
    expect(() => assertChipAmount(amount)).not.toThrow();
  });
  it('keeps the same operation after lost response, remount and arbitrary time', async () => {
    const first = await reserveAgentWalletOperation(intent);
    vi.setSystemTime(new Date('2036-01-01'));
    expect(await reserveAgentWalletOperation({ ...intent })).toEqual(first);
    expect(localStorage.getItem(first.key)).toBe(first.operationId);
    expect(first.key).not.toContain(userId);
    expect(first.key).not.toContain('12.34');
    vi.useRealTimers();
  });
  it('concurrent reservations produce one operation', async () => {
    const requests = await Promise.all(
      Array.from({ length: 20 }, () => reserveAgentWalletOperation(intent))
    );
    expect(new Set(requests.map((r) => r.operationId)).size).toBe(1);
  });
  it.each(['amount', 'clubId', 'targetId', 'userId', 'kind'])(
    'separates changed %s',
    async (field) => {
      const first = await reserveAgentWalletOperation(intent);
      const changed = {
        ...intent,
        [field]:
          field === 'amount'
            ? 12.35
            : field === 'kind'
              ? 'self_stake'
              : '40000000-0000-4000-8000-000000000001',
      };
      expect((await reserveAgentWalletOperation(changed)).operationId).not.toBe(first.operationId);
    }
  );
  it('does not replace corrupt evidence', async () => {
    const first = await reserveAgentWalletOperation(intent);
    localStorage.setItem(first.key, 'corrupt');
    await expect(reserveAgentWalletOperation(intent)).rejects.toThrow(/Saved/);
    expect(localStorage.getItem(first.key)).toBe('corrupt');
  });
  it('refuses to submit if storage silently drops the reservation', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => undefined);
    await expect(reserveAgentWalletOperation(intent)).rejects.toThrow(/Saved/);
  });
  it('refuses when browser coordination is unavailable', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    await expect(reserveAgentWalletOperation(intent)).rejects.toThrow(/Browser/);
  });
  it('clears only the confirmed ID and preserves another operation', async () => {
    const first = await reserveAgentWalletOperation(intent);
    const other = await reserveAgentWalletOperation({ ...intent, amount: 22 });
    await completeAgentWalletOperation({ ...first, operationId: targetId });
    expect(localStorage.getItem(first.key)).toBe(first.operationId);
    await completeAgentWalletOperation(first);
    expect(localStorage.getItem(first.key)).toBeNull();
    expect(localStorage.getItem(other.key)).toBe(other.operationId);
  });
  it('cleanup failure cannot change a confirmed financial result', async () => {
    const first = await reserveAgentWalletOperation(intent);
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('disk');
    });
    await expect(completeAgentWalletOperation(first)).resolves.toBeUndefined();
    expect(await reserveAgentWalletOperation(intent)).toEqual(first);
  });
  it.each([null, {}, { success: 'true' }, { success: true, transaction_id: 'not-a-uuid' }])(
    'rejects unproven receipt %j',
    (data) => {
      expect(confirmedAgentWalletReceipt(data, 12.34, 'agent_send')).toBe(false);
    }
  );
  it('checks receipt amount, balances, ID and destination', () => {
    const receipt = {
      success: true,
      transaction_id: targetId,
      amount: 12.34,
      agent_wallet_after: 10,
      recipient_balance_after: 12.34,
      destination: 'player_wallet',
    };
    expect(confirmedAgentWalletReceipt(receipt, 12.34, 'agent_send')).toBe(true);
    for (const change of [
      { amount: 12.35 },
      { agent_wallet_after: NaN },
      { recipient_balance_after: -1 },
      { destination: 'promo' },
      { transaction_id: '' },
    ]) {
      expect(confirmedAgentWalletReceipt({ ...receipt, ...change }, 12.34, 'agent_send')).toBe(
        false
      );
    }
  });
});
