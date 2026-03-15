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

  it('should have balances in state', () => {
    const state = useWalletStore.getState();
    expect(state.balances).toBeDefined();
  });

  it('should export store with load actions', () => {
    const state = useWalletStore.getState();
    expect(typeof state.loadWallet).toBe('function');
    expect(typeof state.loadDiamonds).toBe('function');
  });
});
