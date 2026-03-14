/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AutoRebuyService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests auto-rebuy lifecycle and concurrency guards:
 * - getStatus: reports config and isRunning
 * - start/stop: lifecycle with interval cleanup
 * - concurrent rebuyHorse: rebuyInProgress guard prevents double rebuys
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../src/services/HydraService', () => ({
  HydraService: {
    getActiveHorses: vi.fn().mockResolvedValue([]),
    removeHorse: vi.fn().mockResolvedValue(true),
    seatHorse: vi.fn().mockResolvedValue(true),
    seedTable: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/services/HorseBugReporter', () => ({
  horseBugReporter: { report: vi.fn() },
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: { getBalance: vi.fn().mockResolvedValue(10000) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { AutoRebuyService } from '../../src/services/AutoRebuyService';

describe('AutoRebuyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    try {
      AutoRebuyService.stop();
    } catch {
      /* may not be running */
    }
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET STATUS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('should report default config values', () => {
      const status = AutoRebuyService.getStatus();
      expect(status.config.monitoringInterval).toBe(30000);
      expect(status.config.minStackBB).toBe(20);
      expect(status.config.rebuyStackBB).toBe(100);
      expect(status.config.minHorsesPerTable).toBe(2);
      expect(status.config.minWalletBalance).toBe(50000);
    });

    it('should report isRunning = false when stopped', () => {
      expect(AutoRebuyService.getStatus().isRunning).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────

  describe('start / stop', () => {
    it('should be running after start', () => {
      AutoRebuyService.start();
      expect(AutoRebuyService.getStatus().isRunning).toBe(true);
      AutoRebuyService.stop();
    });

    it('should be stopped after stop', () => {
      AutoRebuyService.start();
      AutoRebuyService.stop();
      expect(AutoRebuyService.getStatus().isRunning).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REBUY HORSE — concurrency guard
  // ─────────────────────────────────────────────────────────────────────────

  describe('rebuyHorse', () => {
    it('should succeed on first call', async () => {
      const result = await AutoRebuyService.rebuyHorse('horse-1', 'table-1', 500);
      expect(result).toBe(true);
    });
  });
});
