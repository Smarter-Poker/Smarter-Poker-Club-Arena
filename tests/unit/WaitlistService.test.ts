/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — WaitlistService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests waitlist management with bus events:
 * - leave: emits WAITLIST_POSITION_CHANGED
 * - markSeated: emits WAITLIST_POSITION_CHANGED
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

vi.mock('../../src/services/NotificationService', () => ({
  notificationService: {
    notifyWaitlistReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { waitlistService } from '../../src/services/WaitlistService';
import { masterBus } from '../../src/core/MasterBus';

describe('WaitlistService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LEAVE
  // ─────────────────────────────────────────────────────────────────────────

  describe('leave', () => {
    it('should emit WAITLIST_POSITION_CHANGED with position 0', async () => {
      const result = await waitlistService.leave('table-1', 'user-1');
      expect(result).toBe(true);
      expect(masterBus.emit).toHaveBeenCalledWith('WAITLIST_POSITION_CHANGED', {
        tableId: 'table-1',
        position: 0,
        tableName: 'Waitlist',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MARK SEATED
  // ─────────────────────────────────────────────────────────────────────────

  describe('markSeated', () => {
    it('should emit WAITLIST_POSITION_CHANGED with position 0', async () => {
      const result = await waitlistService.markSeated('table-1', 'user-1');
      expect(result).toBe(true);
      expect(masterBus.emit).toHaveBeenCalledWith('WAITLIST_POSITION_CHANGED', {
        tableId: 'table-1',
        position: 0,
        tableName: 'Table',
      });
    });
  });
});
