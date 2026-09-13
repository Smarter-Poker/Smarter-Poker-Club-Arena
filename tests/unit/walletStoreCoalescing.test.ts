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
import { readFileSync } from 'node:fs';
import ts from 'typescript';

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
  getBalance.mockReset();
  getBalances.mockReset();
  getTransactionHistory.mockReset();
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

describe('balance invalidations survive an in-flight snapshot', () => {
  const rows = (balance: number) => [
    { walletType: 'PLAYER', availableBalance: balance, lockedBalance: 0, balance },
  ];

  it('serves a fresh mount from cache but a confirmed change bypasses it', async () => {
    getBalances.mockResolvedValueOnce(rows(40)).mockResolvedValueOnce(rows(60));
    await useWalletStore.getState().loadBalances(USER);
    await useWalletStore.getState().loadBalances(USER);
    expect(getBalances).toHaveBeenCalledOnce();
    await useWalletStore.getState().loadBalances(USER, { force: true });
    expect(getBalances).toHaveBeenCalledTimes(2);
    expect(useWalletStore.getState().balances.PLAYER.total).toBe(60);
  });

  it('collapses invalidations into one trailing read and does not publish the superseded snapshot', async () => {
    const old = deferred<unknown[]>();
    const fresh = deferred<unknown[]>();
    getBalances.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = useWalletStore.getState().loadBalances(USER);
    const baseline = useWalletStore.getState().balances;
    const invalidations = Array.from({ length: 5 }, () =>
      useWalletStore.getState().loadBalances(USER, { force: true })
    );
    expect(getBalances).toHaveBeenCalledOnce();
    old.resolve(rows(10));
    await vi.waitFor(() => expect(getBalances).toHaveBeenCalledTimes(2));
    expect(useWalletStore.getState().balances).toBe(baseline);
    fresh.resolve(rows(80));
    await Promise.all([first, ...invalidations]);
    expect(getBalances).toHaveBeenCalledTimes(2);
    expect(useWalletStore.getState().balances.PLAYER.total).toBe(80);
    expect(useWalletStore.getState().isLoadingWallet).toBe(false);
  });

  it('still catches a change arriving during the trailing read', async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    getBalances
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(rows(90));
    const loading = useWalletStore.getState().loadBalances(USER);
    const change = useWalletStore.getState().loadBalances(USER, { force: true });
    first.resolve(rows(10));
    await vi.waitFor(() => expect(getBalances).toHaveBeenCalledTimes(2));
    const nextChange = useWalletStore.getState().loadBalances(USER, { force: true });
    second.resolve(rows(50));
    await Promise.all([loading, change, nextChange]);
    expect(getBalances).toHaveBeenCalledTimes(3);
    expect(useWalletStore.getState().balances.PLAYER.total).toBe(90);
  });

  it('retires a read and queued refresh when the store resets', async () => {
    const old = deferred<unknown[]>();
    getBalances.mockReturnValueOnce(old.promise);
    const loading = useWalletStore.getState().loadBalances(USER);
    const change = useWalletStore.getState().loadBalances(USER, { force: true });
    useWalletStore.getState().reset();
    old.resolve(rows(500));
    await Promise.all([loading, change]);
    expect(getBalances).toHaveBeenCalledOnce();
    expect(useWalletStore.getState()._balancesUserId).toBeNull();
    expect(useWalletStore.getState().balances.PLAYER.total).toBe(0);
  });

  it('does not publish a previous account read after the next account loads', async () => {
    const old = deferred<unknown[]>();
    getBalances.mockReturnValueOnce(old.promise).mockResolvedValueOnce(rows(30));
    const loading = useWalletStore.getState().loadBalances(USER);
    await useWalletStore.getState().loadBalances('another-user');
    old.resolve(rows(500));
    await loading;
    expect(useWalletStore.getState()._balancesUserId).toBe('another-user');
    expect(useWalletStore.getState().balances.PLAYER.total).toBe(30);
  });
});

it('Cashier BALANCE_UPDATED bypasses the fresh display cache', async () => {
  // Execute the actual subscription callback without mounting unrelated cashier
  // mutation flows. The real store below proves that its options cause a read.
  const source = ts.createSourceFile(
    'CashierPage.tsx',
    readFileSync('src/pages/CashierPage.tsx', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const callbacks: ts.ArrowFunction[] = [];
  const callsBalanceLoader = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) && node.expression.getText(source) === 'loadBalances') ||
    Boolean(ts.forEachChild(node, callsBalanceLoader));
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useMasterBusSubscriptions'
    ) {
      const [events, listener] = node.arguments;
      if (
        events &&
        ts.isArrayLiteralExpression(events) &&
        events.elements.some(
          (event) => ts.isStringLiteral(event) && event.text === 'BALANCE_UPDATED'
        ) &&
        listener &&
        ts.isArrowFunction(listener) &&
        callsBalanceLoader(listener)
      )
        callbacks.push(listener);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(callbacks).toHaveLength(1);
  const callback = callbacks[0];
  const row = (balance: number) => [
    { walletType: 'PLAYER', availableBalance: balance, lockedBalance: 0, balance },
  ];
  getBalances.mockResolvedValueOnce(row(40)).mockResolvedValueOnce(row(60));
  await useWalletStore.getState().loadBalances(USER);
  const loadBalances = vi.fn(useWalletStore.getState().loadBalances);
  const listener = new Function('user', 'loadBalances', `return (${callback!.getText(source)})`)(
    { id: USER },
    loadBalances
  );
  listener();
  await loadBalances.mock.results[0].value;
  expect(getBalances).toHaveBeenCalledTimes(2);
  expect(useWalletStore.getState().balances.PLAYER.total).toBe(60);
});

it('a failed trailing balance read preserves the display and allows the next retry', async () => {
  getBalances.mockResolvedValueOnce([
    { walletType: 'PLAYER', availableBalance: 70, lockedBalance: 0, balance: 70 },
  ]);
  await useWalletStore.getState().loadBalances(USER);
  const old = deferred<unknown[]>();
  getBalances.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('read failed'));
  const loading = useWalletStore.getState().loadBalances(USER, { force: true });
  const change = useWalletStore.getState().loadBalances(USER, { force: true });
  old.resolve([]);
  await Promise.all([loading, change]);
  expect(useWalletStore.getState().balances.PLAYER.total).toBe(70);
  expect(useWalletStore.getState().isLoadingWallet).toBe(false);
  getBalances.mockResolvedValueOnce([
    { walletType: 'PLAYER', availableBalance: 90, lockedBalance: 0, balance: 90 },
  ]);
  await useWalletStore.getState().loadBalances(USER, { force: true });
  expect(useWalletStore.getState().balances.PLAYER.total).toBe(90);
});
