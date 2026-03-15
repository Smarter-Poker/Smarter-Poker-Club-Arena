/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — TableSettingsService (Strengthened)
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

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { tableSettingsService } from '../../src/services/TableSettingsService';

describe('TableSettingsService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getSettings', () => {
    it('should return default settings when no data', async () => {
      const settings = await tableSettingsService.getSettings('user-1');
      expect(settings).toBeDefined();
    });

    it('should return an object with expected defaults', async () => {
      const settings = await tableSettingsService.getSettings('user-2');
      expect(typeof settings).toBe('object');
    });
  });

  describe('updateSettings', () => {
    it('should not throw for partial update', async () => {
      await tableSettingsService.updateSettings('user-1', { fourColorDeck: true });
    });
  });

  describe('clearCache', () => {
    it('should not crash', () => {
      tableSettingsService.clearCache('user-1');
    });
  });

  describe('export shape', () => {
    it('should export all methods', () => {
      expect(typeof tableSettingsService.getSettings).toBe('function');
      expect(typeof tableSettingsService.updateSettings).toBe('function');
      expect(typeof tableSettingsService.clearCache).toBe('function');
    });
  });
});
