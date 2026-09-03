/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — useGlobalBalanceSync
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/stores/useWalletStore', () => ({
  useWalletStore: vi.fn(() => ({ refreshAll: vi.fn(), loadDiamonds: vi.fn() })),
}));

vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: vi.fn(() => ({ user: null })),
}));

import { useGlobalBalanceSync, GlobalBalanceSync } from '../../src/core/useGlobalBalanceSync';

describe('useGlobalBalanceSync', () => {
  it('should export useGlobalBalanceSync as a function', () => {
    expect(typeof useGlobalBalanceSync).toBe('function');
  });

  it('should export GlobalBalanceSync as a function', () => {
    expect(typeof GlobalBalanceSync).toBe('function');
  });
});
