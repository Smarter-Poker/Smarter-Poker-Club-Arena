import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  reserveCashierWalletOperation,
  clearCashierWalletOperation,
  readCashierWalletOperations,
} from '../../src/services/CashierWalletRecovery';

const server = vi.hoisted(() => new Map<string, any>());
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (name: string, args: any) => {
      const key = `${args.p_actor_id}:${args.p_club_id}:${args.p_kind}:${args.p_intent_key}`;
      if (name.endsWith('_reserve')) {
        if (!server.has(key)) server.set(key, structuredClone(args.p_envelope));
        return { data: structuredClone(server.get(key)), error: null };
      }
      if (name.endsWith('_ack')) {
        const row = server.get(key);
        const same = row?.operationId === args.p_identity;
        if (same) server.delete(key);
        return { data: same, error: null };
      }
      if (name.endsWith('_read'))
        return {
          data: [...server.values()].filter(
            (row) => row.userId === args.p_actor_id && row.clubId === args.p_club_id
          ),
          error: null,
        };
      throw new Error('Unexpected RPC ' + name);
    }),
  },
}));
const user = '11111111-1111-4111-8111-111111111111';
const club = '22222222-2222-4222-8222-222222222222';
const target = '33333333-3333-4333-8333-333333333333';
const action = 'fn_agent_wallet_send';
const args = {
  p_to_user_id: target,
  p_amount: 10,
  p_reason: 'Private Recipient Note',
  p_destination: 'player_wallet',
};
beforeEach(() => {
  localStorage.clear();
  server.clear();
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});
describe('durable wallet operation identity', () => {
  it('accepts existing PostgreSQL entity IDs without weakening operation UUID validation', async () => {
    const existingClub = 'a0000000-0000-0000-0000-000000000001';
    const first = await reserveCashierWalletOperation(user, existingClub, action, args);
    expect(first).not.toBeNull();
    expect(await reserveCashierWalletOperation(user, existingClub, action, args)).toEqual(first);
    expect(readCashierWalletOperations(user, existingClub)).toEqual([first]);
    await clearCashierWalletOperation(first!);
    expect(readCashierWalletOperations(user, existingClub)).toEqual([]);
    expect(
      await reserveCashierWalletOperation(
        user,
        club,
        action,
        args,
        () => existingClub,
        localStorage
      )
    ).toBeNull();
    expect(
      await reserveCashierWalletOperation(
        user,
        '00000000-0000-0000-0000-000000000000',
        action,
        args
      )
    ).toBeNull();
  });
  it('uses the same operation after reload, without persisting the reason', async () => {
    const first = await reserveCashierWalletOperation(user, club, action, args);
    expect(first).not.toBeNull();
    expect(await reserveCashierWalletOperation(user, club, action, args)).toEqual(first);
    expect(
      Array.from({ length: localStorage.length }, (_, i) =>
        localStorage.getItem(localStorage.key(i)!)
      ).join(' ')
    ).not.toContain(args.p_reason);
    expect(readCashierWalletOperations(user, club)).toEqual([first]);
  });
  it('isolates every defining field and retains unresolved older intents', async () => {
    const first = await reserveCashierWalletOperation(user, club, action, args);
    for (const change of [
      { p_amount: 11 },
      { p_reason: 'Other Note' },
      { p_destination: 'agent_wallet' },
    ]) {
      const next = await reserveCashierWalletOperation(user, club, action, { ...args, ...change });
      expect(next?.operationId).not.toBe(first?.operationId);
    }
    expect(readCashierWalletOperations(user, club)).toHaveLength(4);
    expect(readCashierWalletOperations(target, club)).toHaveLength(0);
    expect(readCashierWalletOperations(user, target)).toHaveLength(0);
  });
  it('clears only the exact confirmed operation', async () => {
    const first = (await reserveCashierWalletOperation(user, club, action, args))!;
    await clearCashierWalletOperation({ ...first, operationId: target });
    expect(readCashierWalletOperations(user, club)).toHaveLength(1);
    await clearCashierWalletOperation(first);
    expect(readCashierWalletOperations(user, club)).toHaveLength(0);
  });
  it('refuses corrupt or silently discarded storage before dispatch', async () => {
    const first = (await reserveCashierWalletOperation(user, club, action, args))!;
    localStorage.setItem(localStorage.key(0)!, '{broken');
    expect(await reserveCashierWalletOperation(user, club, action, args)).toBeNull();
    expect(
      await reserveCashierWalletOperation(user, club, action, args, () => first.operationId, {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      })
    ).toBeNull();
  });
  it('reserves durably without browser locks or writable storage', async () => {
    const locks = navigator.locks;
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    try {
      const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('Full', 'QuotaExceededError');
      });
      const first = await reserveCashierWalletOperation(user, club, action, args);
      expect(first).not.toBeNull();
      expect(await reserveCashierWalletOperation(user, club, action, args)).toEqual(first);
      write.mockRestore();
    } finally {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    }
    expect(localStorage.length).toBe(0);
  });
  it('uses the authoritative server identity when browser reads and writes are disabled', async () => {
    const first = await reserveCashierWalletOperation(user, club, action, args);
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('Disabled', 'SecurityError');
    });
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Disabled', 'SecurityError');
    });
    try {
      expect(await reserveCashierWalletOperation(user, club, action, args)).toEqual(first);
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });
  it('same-intent concurrent reservations share the server identity', async () => {
    let chain = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_key: string, _options: unknown, callback: () => unknown) => {
          const pending = chain.then(callback);
          chain = pending.then(() => undefined);
          return pending;
        },
      },
    });
    const rows = await Promise.all(
      Array.from({ length: 5 }, () => reserveCashierWalletOperation(user, club, action, args))
    );
    expect(new Set(rows.map((row) => row?.operationId)).size).toBe(1);
  });
});
