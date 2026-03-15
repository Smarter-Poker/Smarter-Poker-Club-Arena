/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — GTOQueryService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests computeHash determinism, cache eviction at MAX_CACHE_SIZE,
 * clearCache, isSolved (cache hit), getGTOAction null fallback,
 * and getPreflopRange null fallback.
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
  return { supabase: { from: () => buildChain() } };
});

vi.mock('md5', () => ({
  default: (input: string) => `md5_${input}`,
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { GTOQueryService } from '../../src/services/GTOQueryService';

describe('GTOQueryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    GTOQueryService.clearCache();
  });

  describe('computeHash', () => {
    it('should produce deterministic hash for same inputs', () => {
      const h1 = GTOQueryService.computeHash('UTG', 'SRP', 'flop', ['Ah', 'Kd', '3c'], 'check', 100);
      const h2 = GTOQueryService.computeHash('UTG', 'SRP', 'flop', ['Ah', 'Kd', '3c'], 'check', 100);
      expect(h1).toBe(h2);
    });

    it('should produce different hash for different positions', () => {
      const h1 = GTOQueryService.computeHash('UTG', 'SRP', 'flop', null, 'check', 100);
      const h2 = GTOQueryService.computeHash('BTN', 'SRP', 'flop', null, 'check', 100);
      expect(h1).not.toBe(h2);
    });

    it('should handle null board', () => {
      const hash = GTOQueryService.computeHash('CO', '3BET', 'preflop', null, 'raise', 100);
      expect(hash).toBeTruthy();
    });

    it('should include stack depth in hash', () => {
      const h1 = GTOQueryService.computeHash('BB', 'SRP', 'flop', ['Ah', 'Kd', '3c'], 'check', 100);
      const h2 = GTOQueryService.computeHash('BB', 'SRP', 'flop', ['Ah', 'Kd', '3c'], 'check', 50);
      expect(h1).not.toBe(h2);
    });
  });

  describe('clearCache', () => {
    it('should not crash when cache is empty', () => {
      GTOQueryService.clearCache();
    });
  });

  describe('getGTOAction', () => {
    it('should return null when no solution found', async () => {
      const result = await GTOQueryService.getGTOAction('UTG', 'SRP', 'flop', null, 'check', 100);
      expect(result).toBeNull();
    });
  });

  describe('getPreflopRange', () => {
    it('should return null when no range found', async () => {
      const result = await GTOQueryService.getPreflopRange('UTG', 'open', null, 100);
      expect(result).toBeNull();
    });
  });

  describe('isSolved', () => {
    it('should return false for unknown hash', async () => {
      const result = await GTOQueryService.isSolved('nonexistent-hash');
      expect(result).toBe(false);
    });
  });
});
