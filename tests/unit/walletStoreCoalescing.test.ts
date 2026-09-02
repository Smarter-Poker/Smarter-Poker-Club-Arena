/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WALLET STORE — concurrent loads must make ONE request, not N
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Pins the fix for the 2026-08-28 measurement: opening a single tournament
 * page fired 85 Supabase round trips, the last landing at 8.6 seconds, and
 * `wallet_transactions` alone was hit 20 times. The store's freshness stamp
 * could not prevent it, because the stamp is written only AFTER a request
 * returns — so components mounting in the same tick all read the same stale
 * stamp and all fetched.
 *
 * These tests describe the property that matters, not the implementation: if
 * several callers ask at once, the service is called ONCE and everybody gets
 * the same answer. They fail if the coalescing map is removed, and they also
 * fail if it is "optimised" into caching a rejected promise, which would leave
 * a wallet broken for the rest of the session after one flaky request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getBalance = vi.fn();
const getBalances = vi.fn();
const getTransactionHistory = vi.fn();

vi.mock('../../src/services/DiamondService', () => ({
  DiamondService: { getBalance: (...a: unknown[]) => getBalance(...a) },
}));
vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    getBalances: (...a: unknown[]) => getBalances(...a),
    getTransactionHistory: (...a: unknown[]) => getTransactionHistory(...a),
  },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { useWalletStore } from '../../src/stores/useWalletStore';

const USER = 'user-under-test';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.clearAllMocks();
  // Clear the freshness stamps so each test starts from a cold store; without
  // this the SECOND test would be served by the cache and prove nothing.
  useWalletStore.setState({
    _diamondsAt: 0,
    _diamondsUserId: null,
    _balancesAt: 0,
    _balancesUserId: null,
  } as never);
});

describe('the wallet store does not stampede', () => {
  it('collapses six concurrent loadDiamonds calls into one service call', async () => {
    const gate = deferred<{ balance: number; lifetimeEarned: number; lifetimeSpent: number }>();
    getBalance.mockReturnValue(gate.promise);

    const callers = Array.from({ length: 6 }, () => useWalletStore.getState().loadDiamonds(USER));

    // Every caller is now waiting. Exactly one request went out.
    expect(getBalance).toHaveBeenCalledTimes(1);

    gate.resolve({ balance: 42, lifetimeEarned: 0, lifetimeSpent: 0 });
    await Promise.all(callers);

    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(useWalletStore.getState().diamonds).toBe(42);
  });

  it('collapses concurrent loadTransactions calls, which had no freshness guard at all', async () => {
    const gate = deferred<unknown[]>();
    getTransactionHistory.mockReturnValue(gate.promise);

    const callers = Array.from({ length: 5 }, () =>
      useWalletStore.getState().loadTransactions(USER)
    );
    expect(getTransactionHistory).toHaveBeenCalledTimes(1);

    gate.resolve([]);
    await Promise.all(callers);
    expect(getTransactionHistory).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent loadBalances calls', async () => {
    const gate = deferred<unknown[]>();
    getBalances.mockReturnValue(gate.promise);

    const callers = Array.from({ length: 4 }, () => useWalletStore.getState().loadBalances(USER));
    expect(getBalances).toHaveBeenCalledTimes(1);

    gate.resolve([]);
    await Promise.all(callers);
    expect(getBalances).toHaveBeenCalledTimes(1);
  });

  it('lets the NEXT caller retry after a failure, rather than inheriting it', async () => {
    // A rejected promise left in the map would cache the failure and every
    // later mount would inherit it. The wallet would stay broken for the whole
    // session because of one flaky request.
    getBalance.mockRejectedValueOnce(new Error('network blip'));
    await useWalletStore.getState().loadDiamonds(USER);
    expect(getBalance).toHaveBeenCalledTimes(1);

    getBalance.mockResolvedValueOnce({ balance: 7, lifetimeEarned: 0, lifetimeSpent: 0 });
    await useWalletStore.getState().loadDiamonds(USER, { force: true });

    expect(getBalance).toHaveBeenCalledTimes(2);
    expect(useWalletStore.getState().diamonds).toBe(7);
  });
});
