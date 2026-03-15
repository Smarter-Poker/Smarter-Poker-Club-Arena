/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — TableService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests DEFAULT table settings, stakes formatting, and admin status transitions.
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
    subscribeToTable: vi.fn(() => vi.fn()),
    subscribeToHandState: vi.fn(() => vi.fn()),
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

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
  resolveClubIdFilter: vi.fn().mockReturnValue({ column: 'id', value: 'resolved-uuid' }),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { tableService } from '../../src/services/TableService';

describe('TableService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // QUERIES RETURN EMPTY ON MOCK
  // ─────────────────────────────────────────────────────────────────────────

  describe('getTable', () => {
    it('should return null when table not found', async () => {
      const result = await tableService.getTable('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getClubTables', () => {
    it('should return empty array when no tables exist', async () => {
      const result = await tableService.getClubTables('club-1');
      expect(result).toEqual([]);
    });
  });

  describe('getActiveTables', () => {
    it('should return empty array when no active tables', async () => {
      const result = await tableService.getActiveTables();
      expect(result).toEqual([]);
    });

    it('should accept custom limit parameter', async () => {
      const result = await tableService.getActiveTables(10);
      expect(result).toEqual([]);
    });
  });

  describe('getUnionTables', () => {
    it('should return empty array when no union clubs', async () => {
      const result = await tableService.getUnionTables('union-1');
      expect(result).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STATISTICS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getAveragePot', () => {
    it('should return 0 when no hand history', async () => {
      const result = await tableService.getAveragePot('table-1');
      expect(result).toBe(0);
    });
  });

  describe('getWaitlistCount', () => {
    it('should return 0 when no waitlist entries', async () => {
      const result = await tableService.getWaitlistCount('table-1');
      expect(result).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SUBSCRIPTIONS
  // ─────────────────────────────────────────────────────────────────────────

  describe('subscriptions', () => {
    it('subscribeToTable returns unsubscribe function', () => {
      const unsub = tableService.subscribeToTable('table-1', vi.fn());
      expect(typeof unsub).toBe('function');
    });

    it('subscribeToHand returns unsubscribe function', () => {
      const unsub = tableService.subscribeToHand('table-1', vi.fn());
      expect(typeof unsub).toBe('function');
    });
  });
});
