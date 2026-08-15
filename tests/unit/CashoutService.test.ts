/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — CashoutService (Strengthened)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
      // 2026-08-15: this suite-local mock overrides the (complete) global one in
      // tests/setup.ts and had NO `auth`, so every privileged path exploded with
      // "Cannot read properties of undefined (reading 'getSession')" inside
      // callClubArenaApi (clubArenaApi.ts:50). cancel/approve/reject all route
      // through that helper. A session WITH an access_token is used so the tests
      // exercise the real request, not the 'Not authenticated' short-circuit.
      auth: {
        getSession: vi.fn(() =>
          Promise.resolve({
            data: { session: { access_token: 'test-jwt', user: { id: 'player-1' } } },
            error: null,
          })
        ),
        getUser: vi.fn(() =>
          Promise.resolve({ data: { user: { id: 'player-1' } }, error: null })
        ),
      },
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

import { cashoutService } from '../../src/services/CashoutService';
import { masterBus } from '../../src/core/MasterBus';

describe('CashoutService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getCashout', () => {
    it('should return null for unknown cashout', async () => {
      const result = await cashoutService.getCashout('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getAgentPendingCashouts', () => {
    it('should return empty array when no pending cashouts', async () => {
      const result = await cashoutService.getAgentPendingCashouts('agent-1');
      expect(result).toEqual([]);
    });

    it('should accept optional clubId filter', async () => {
      const result = await cashoutService.getAgentPendingCashouts('agent-1', 'club-1');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('export shape', () => {
    it('should export cashoutService with all methods', () => {
      expect(typeof cashoutService.requestCashout).toBe('function');
      expect(typeof cashoutService.cancelCashout).toBe('function');
      expect(typeof cashoutService.approveCashout).toBe('function');
      expect(typeof cashoutService.completeCashout).toBe('function');
      expect(typeof cashoutService.rejectCashout).toBe('function');
      expect(typeof cashoutService.getCashout).toBe('function');
      expect(typeof cashoutService.getAgentPendingCashouts).toBe('function');
    });
  });

  describe('edge cases', () => {
    // 2026-08-15: cancelCashout / approveCashout do NOT have a `false` return.
    // Both delegate the whole operation to the server route via
    // callClubArenaApi (CashoutService.ts:140 and :161), which THROWS the
    // server-supplied message on a non-2xx or `{ success: false }` payload
    // (clubArenaApi.ts:72-74); they return true only once the route accepted
    // the request. So an unknown id surfaces as a rejection carrying the
    // server's reason, not a silent falsy result. These tests now assert that
    // — including that no balance event is emitted for money that never moved.
    const mockApiFailure = (error: string, status = 404) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve({
            ok: false,
            status,
            json: () => Promise.resolve({ success: false, error }),
          })
        )
      );

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should reject with the server reason for cancelCashout on nonexistent id', async () => {
      mockApiFailure('Cashout not found');
      await expect(
        cashoutService.cancelCashout('nonexistent-id', 'player-1')
      ).rejects.toThrow('Cashout not found');
      expect(masterBus.emit).not.toHaveBeenCalledWith(
        'BALANCE_UPDATED',
        expect.anything()
      );
    });

    it('should throw on rejectCashout for nonexistent id', async () => {
      await expect(
        cashoutService.rejectCashout('some-id', 'Suspicious activity')
      ).rejects.toThrow();
    });

    it('should reject with the server reason for approveCashout on unknown id', async () => {
      mockApiFailure('Cashout not found');
      await expect(cashoutService.approveCashout('unknown-id', 'agent-1')).rejects.toThrow(
        'Cashout not found'
      );
      expect(masterBus.emit).not.toHaveBeenCalledWith(
        'CASHOUT_APPROVED',
        expect.anything()
      );
    });

    it('should refuse to act when there is no session', async () => {
      // callClubArenaApi requires a JWT; with no session the client must fail
      // closed before any request is made (clubArenaApi.ts:52).
      const { supabase } = await import('../../src/lib/supabase');
      const getSession = supabase.auth.getSession as unknown as ReturnType<typeof vi.fn>;
      getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(cashoutService.cancelCashout('some-id', 'player-1')).rejects.toThrow(
        'Not authenticated'
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
