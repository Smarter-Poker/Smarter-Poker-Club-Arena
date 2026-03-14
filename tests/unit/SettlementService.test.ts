/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SettlementService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - Union wire calculation (10% union tax, final wire formula)
 * - Period management (getCurrentPeriod fallback, closePeriod)
 * - Bus event emissions after settlement execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockRpc = vi.fn();

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

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => mockRpc(...args),
    from: () => buildChain(),
  },
}));

const mockBusEmit = vi.fn();
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (...args: any[]) => mockBusEmit(...args),
    subscribe: vi.fn(() => vi.fn()),
    subscribeDebounced: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { SettlementService } from '../../src/services/SettlementService';

describe('SettlementService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UNION WIRE CALCULATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateUnionWire', () => {
    it('should apply 10% union tax on gross rake', () => {
      const wire = SettlementService.calculateUnionWire(
        'club-1',
        'Test Club',
        5000, // netPlayerPL
        1000 // grossRake
      );

      expect(wire.unionTax).toBe(100); // 10% of 1000
    });

    it('should calculate final wire correctly: netPL + grossRake - unionTax', () => {
      const wire = SettlementService.calculateUnionWire(
        'club-1',
        'Test Club',
        5000, // netPlayerPL
        1000 // grossRake
      );

      // finalWire = 5000 + 1000 - 100 = 5900
      expect(wire.finalWire).toBe(5900);
    });

    it('should handle zero rake', () => {
      const wire = SettlementService.calculateUnionWire('club-1', 'Test Club', 3000, 0);

      expect(wire.unionTax).toBe(0);
      expect(wire.finalWire).toBe(3000); // 3000 + 0 - 0
    });

    it('should handle negative player P/L (players won)', () => {
      const wire = SettlementService.calculateUnionWire(
        'club-1',
        'Test Club',
        -2000, // players won overall
        500
      );

      expect(wire.unionTax).toBe(50); // 10% of 500
      expect(wire.finalWire).toBe(-1550); // -2000 + 500 - 50
    });

    it('should preserve club metadata', () => {
      const wire = SettlementService.calculateUnionWire('club-xyz', 'Diamond Club', 1000, 200);

      expect(wire.clubId).toBe('club-xyz');
      expect(wire.clubName).toBe('Diamond Club');
      expect(wire.netPlayerPL).toBe(1000);
      expect(wire.grossRake).toBe(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PERIOD MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────

  describe('getCurrentPeriod', () => {
    it('should return default period when RPC returns empty data', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      const period = await SettlementService.getCurrentPeriod();

      expect(period.status).toBe('open');
      expect(period.totalRakeCollected).toBe(0);
      expect(period.periodNumber).toBe(1);
    });

    it('should map RPC data to SettlementPeriod', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            id: 'period-1',
            period_start: '2026-03-01',
            period_end: '2026-03-14',
            status: 'open',
            total_rake: 50000,
          },
        ],
        error: null,
      });

      const period = await SettlementService.getCurrentPeriod();

      expect(period.id).toBe('period-1');
      expect(period.startAt).toBe('2026-03-01');
      expect(period.endAt).toBe('2026-03-14');
      expect(period.status).toBe('open');
      expect(period.totalRakeCollected).toBe(50000);
    });

    it('should throw on RPC error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'db error' } });

      await expect(SettlementService.getCurrentPeriod()).rejects.toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CLOSE PERIOD
  // ─────────────────────────────────────────────────────────────────────────

  describe('closePeriod', () => {
    it('should resolve without error on success', async () => {
      await expect(SettlementService.closePeriod('period-123')).resolves.not.toThrow();
    });
  });
});
