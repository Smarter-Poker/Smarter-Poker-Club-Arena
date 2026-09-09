import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  state: { user: { id: 'player-a' } as { id: string } | null, updateTotalChips: vi.fn() },
  read: vi.fn(),
  report: vi.fn(),
  listeners: new Map<string, () => void>(),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: vi.fn((event: string, callback: () => void) => {
      mocks.listeners.set(event, callback);
      return () => mocks.listeners.delete(event);
    }),
  },
}));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state,
    }
  ),
}));
vi.mock('../../src/services/WalletService', () => ({
  WalletService: { readPlayerBalance: mocks.read },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
import { useGlobalBalanceSync, GlobalBalanceSync } from '../../src/core/useGlobalBalanceSync';

function pendingRead() {
  let resolve!: (value: { balance: number | null }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ balance: number | null }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  mocks.read.mockReturnValueOnce(promise);
  return { resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.state.user = { id: 'player-a' };
  mocks.read.mockReset();
});
afterEach(cleanup);

describe('global balance read ownership', () => {
  it('exports the headless component', () => {
    expect(typeof GlobalBalanceSync).toBe('function');
  });
  it('applies the current account initial balance', async () => {
    mocks.read.mockResolvedValue({ balance: 80 });
    await act(async () => {
      renderHook(() => useGlobalBalanceSync());
    });
    expect(mocks.read).toHaveBeenCalledWith('player-a');
    expect(mocks.state.updateTotalChips).toHaveBeenCalledWith(80);
  });
  it.each(['BALANCE_UPDATED', 'CONNECTION_RESTORED'])(
    'does not let an older read overwrite a %s refresh',
    async (event) => {
      const old = pendingRead();
      const fresh = pendingRead();
      renderHook(() => useGlobalBalanceSync());
      act(() => mocks.listeners.get(event)!());
      await act(async () => fresh.resolve({ balance: 90 }));
      await act(async () => old.resolve({ balance: 20 }));
      expect(mocks.state.updateTotalChips.mock.calls).toEqual([[90]]);
    }
  );
  it.each(['player-b', null])(
    'rejects an old account result when current identity becomes %s before effect cleanup',
    async (id) => {
      const old = pendingRead();
      renderHook(() => useGlobalBalanceSync());
      mocks.state.user = id ? { id } : null;
      await act(async () => old.resolve({ balance: 200 }));
      expect(mocks.state.updateTotalChips).not.toHaveBeenCalled();
    }
  );
  it('allows the new account read while rejecting the previous effect result', async () => {
    const old = pendingRead();
    const fresh = pendingRead();
    const hook = renderHook(() => useGlobalBalanceSync());
    mocks.state.user = { id: 'player-b' };
    hook.rerender();
    await act(async () => fresh.resolve({ balance: 30 }));
    await act(async () => old.resolve({ balance: 500 }));
    expect(mocks.read.mock.calls).toEqual([['player-a'], ['player-b']]);
    expect(mocks.state.updateTotalChips.mock.calls).toEqual([[30]]);
  });
  it('retires pending reads and queued callbacks on unmount', async () => {
    const old = pendingRead();
    const hook = renderHook(() => useGlobalBalanceSync());
    const queued = mocks.listeners.get('BALANCE_UPDATED')!;
    hook.unmount();
    await act(async () => old.resolve({ balance: 200 }));
    act(() => queued());
    expect(mocks.state.updateTotalChips).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.listeners.size).toBe(0);
  });
  it('preserves the known balance when the current read is unknown', async () => {
    mocks.read.mockResolvedValue({ balance: null });
    await act(async () => {
      renderHook(() => useGlobalBalanceSync());
    });
    expect(mocks.state.updateTotalChips).not.toHaveBeenCalled();
  });
  it('reports genuine read failures', async () => {
    const error = new Error('read refused');
    mocks.read.mockRejectedValue(error);
    await act(async () => {
      renderHook(() => useGlobalBalanceSync());
    });
    expect(mocks.report).toHaveBeenCalledWith(
      error,
      'useGlobalBalanceSync.Failed_to_fetch_atomic_ledger_balance'
    );
    expect(mocks.state.updateTotalChips).not.toHaveBeenCalled();
  });
});
