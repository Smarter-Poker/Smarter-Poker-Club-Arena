/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — WaitlistService (Strengthened)
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

import { waitlistService } from '../../src/services/WaitlistService';

describe('WaitlistService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getWaitlist', () => {
    it('should return empty array when no entries', async () => {
      const result = await waitlistService.getWaitlist('table-1');
      expect(result).toEqual([]);
    });

    it('should accept any tableId', async () => {
      const result = await waitlistService.getWaitlist('nonexistent');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getPosition', () => {
    it('should return null when not on waitlist', async () => {
      const pos = await waitlistService.getPosition('table-1', 'user-1');
      expect(pos).toBeNull();
    });
  });

  describe('notifyNextPlayer', () => {
    it('should return false when no players waiting', async () => {
      const result = await waitlistService.notifyNextPlayer('table-1');
      expect(result).toBe(false);
    });
  });

  describe('export shape', () => {
    it('should export waitlistService singleton with all methods', () => {
      expect(typeof waitlistService.getWaitlist).toBe('function');
      expect(typeof waitlistService.getPosition).toBe('function');
      expect(typeof waitlistService.joinWaitlist).toBe('function');
      expect(typeof waitlistService.leaveWaitlist).toBe('function');
      expect(typeof waitlistService.notifyNextPlayer).toBe('function');
      expect(typeof waitlistService.markSeated).toBe('function');
    });
  });
});
