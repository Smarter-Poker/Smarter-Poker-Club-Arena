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
      from: vi.fn(() => buildChain()),
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

/* `resolved-uuid` is not a UUID, and getClubTables now REFUSES to build a
   PostgREST `or=` filter out of anything that is not one - the resolver
   returns its input unchanged when it cannot resolve, so a slug used to be
   concatenated straight into the filter grammar. The mock returns a real UUID
   so the method under test reaches its query, and `isUUID` is mocked
   alongside the two functions that were already here. */
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('11111111-2222-4333-8444-555555555555'),
  resolveClubIdFilter: vi
    .fn()
    .mockReturnValue({ column: 'id', value: '11111111-2222-4333-8444-555555555555' }),
  isUUID: (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { tableService } from '../../src/services/TableService';
import { supabase } from '../../src/lib/supabase';

describe('TableService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSeatedPlayers', () => {
    it.each(['demo', 'nonexistent-table-id', '', 'undefined', 'id.eq.secret,club_id.not.is.null'])(
      'does not query seats for an invalid table ID: %s',
      async (tableId) => {
        expect(await tableService.getSeatedPlayers(tableId)).toEqual([]);
        expect(supabase.from).not.toHaveBeenCalled();
      }
    );

    it('still reads the seats of a valid table ID', async () => {
      expect(await tableService.getSeatedPlayers('11111111-2222-4333-8444-555555555555')).toEqual(
        []
      );
      expect(supabase.from).toHaveBeenCalledExactlyOnceWith('table_seats');
    });
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

    it('refuses a club id that did not resolve to a UUID', async () => {
      /* Rather than concatenating it into `or=`, where a slug containing a
         comma or a bracket splits the expression and returns 400 - and a
         clean slug still hits a uuid column and errors - both of which
         rendered as "this club has no games". */
      const { resolveClubUUID } = await import('../../src/utils/clubIdResolver');
      (
        resolveClubUUID as unknown as { mockResolvedValueOnce: (v: string) => void }
      ).mockResolvedValueOnce('my-club-slug');
      await expect(tableService.getClubTables('my-club-slug')).rejects.toThrow(
        'That Club Could Not Be Resolved'
      );
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
    it('returns null when there is no hand history — unknown is not zero', async () => {
      /* ITEM E audit 2026-08-26: 0 used to mean both "no hands" and "the
         read failed", which forced the caller to guess. null = could not
         find out / nothing to average; a number = a real average. */
      const result = await tableService.getAveragePot('table-1');
      expect(result).toBeNull();
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

    it('subscribeToHand is gone — hand state comes from the engine socket', () => {
      // 2026-08-15: the old test expected tableService.subscribeToHand to
      // return an unsubscribe function. That helper was INTENTIONALLY deleted
      // in "Phase 1.1 PR-5 (NO-GO-2)" (TableService.ts:544-549): hand/game
      // state is now consumed by TablePage through
      // src/hooks/useEngineTableState.ts over the engine WebSocket, not via
      // Supabase Realtime. Pin the removal so the dead path cannot come back.
      const surface = tableService as unknown as Record<string, unknown>;
      expect(surface.subscribeToHand).toBeUndefined();
      // The surviving metadata subscription still exists and is exercised above.
      expect(typeof tableService.subscribeToTable).toBe('function');
    });
  });
});
