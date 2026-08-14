/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useWalletStore
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    getBalances: vi.fn().mockResolvedValue([]),
    getTransactions: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { useWalletStore } from '../../src/stores/useWalletStore';

describe('useWalletStore', () => {
  beforeEach(() => {
    useWalletStore.setState({
      isLoadingWallet: false,
      isLoadingDiamonds: false,
      diamonds: 0,
      balances: {} as any, // Mocking initial state
    });
  });

  it('should start with 0 diamonds', () => {
    expect(useWalletStore.getState().diamonds).toBe(0);
  });

  it('should not be loading by default', () => {
    expect(useWalletStore.getState().isLoadingWallet).toBe(false);
  });

  it('should not be loading diamonds by default', () => {
    expect(useWalletStore.getState().isLoadingDiamonds).toBe(false);
  });

  it('should export store with load actions', () => {
    const state = useWalletStore.getState();
    expect(typeof state.loadBalances).toBe('function');
    expect(typeof state.loadDiamonds).toBe('function');
    expect(typeof state.loadTransactions).toBe('function');
    expect(typeof state.refreshAll).toBe('function');
    expect(typeof state.lockForBuyIn).toBe('function');
    // AUDIT M17: unlockFromTable is deliberately gone — see WalletService.
    expect((state as unknown as Record<string, unknown>).unlockFromTable).toBeUndefined();
    expect(typeof state.internalTransfer).toBe('function');
    expect(typeof state.mintChips).toBe('function');
    expect(typeof state.reset).toBe('function');
  });
});
