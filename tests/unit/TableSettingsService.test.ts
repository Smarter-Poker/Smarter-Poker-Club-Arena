/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — TableSettingsService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests DEFAULT_SETTINGS values, cache behavior, and clearCache.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

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
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { tableSettingsService } from '../../src/services/TableSettingsService';

describe('TableSettingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tableSettingsService.clearCache('user-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DEFAULT SETTINGS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getSettings (default fallback)', () => {
    it('should return default settings when no data exists', async () => {
      const settings = await tableSettingsService.getSettings('user-1');
      expect(settings.showStackInBB).toBe(false);
      expect(settings.offlineProtection).toBe(false);
      expect(settings.autoTimeBank).toBe(false);
      expect(settings.fourColorDeck).toBe(false);
      expect(settings.autoMuck).toBe(true);
      expect(settings.showChat).toBe(true);
      expect(settings.soundEnabled).toBe(true);
    });

    it('should cache results on second call', async () => {
      const s1 = await tableSettingsService.getSettings('user-1');
      const s2 = await tableSettingsService.getSettings('user-1');
      expect(s1).toBe(s2); // Same reference = cached
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CLEAR CACHE
  // ─────────────────────────────────────────────────────────────────────────

  describe('clearCache', () => {
    it('should force re-fetch after cache clear', async () => {
      await tableSettingsService.getSettings('user-1'); // Prime cache
      tableSettingsService.clearCache('user-1');
      const s = await tableSettingsService.getSettings('user-1');
      // Should still get defaults (mocked RPC returns null)
      expect(s.autoMuck).toBe(true);
    });
  });
});
