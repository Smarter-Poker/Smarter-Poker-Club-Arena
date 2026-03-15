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

  describe('getTableWaitlist', () => {
    it('should return empty array when no entries', async () => {
      const result = await waitlistService.getTableWaitlist('table-1');
      expect(result).toEqual([]);
    });

    it('should accept any tableId', async () => {
      const result = await waitlistService.getTableWaitlist('nonexistent');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getPosition', () => {
    it('should return null when not on waitlist', async () => {
      const pos = await waitlistService.getPosition('table-1', 'user-1');
      expect(pos).toBeNull();
    });
  });

  describe('getUserWaitlistEntry', () => {
    it('should return null when no entry', async () => {
      const result = await waitlistService.getUserWaitlistEntry('table-1', 'user-1');
      expect(result).toBeNull();
    });
  });

  describe('getUserWaitlists', () => {
    it('should return empty array when user has no waitlists', async () => {
      const result = await waitlistService.getUserWaitlists('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('export shape', () => {
    it('should export waitlistService singleton with all methods', () => {
      expect(typeof waitlistService.join).toBe('function');
      expect(typeof waitlistService.leave).toBe('function');
      expect(typeof waitlistService.getPosition).toBe('function');
      expect(typeof waitlistService.getUserWaitlistEntry).toBe('function');
      expect(typeof waitlistService.getUserWaitlists).toBe('function');
      expect(typeof waitlistService.getTableWaitlist).toBe('function');
      expect(typeof waitlistService.notifyNextPlayer).toBe('function');
      expect(typeof waitlistService.markSeated).toBe('function');
    });
  });
});
