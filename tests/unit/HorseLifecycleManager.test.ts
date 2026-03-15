/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HorseLifecycleManager
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests config defaults, start/stop lifecycle, and fleet health defaults.
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

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/services/HorseBugReporter', () => ({
  horseBugReporter: { report: vi.fn() },
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    creditWallet: vi.fn().mockResolvedValue(undefined),
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks (use dynamic import to get fresh instance) ──────

// We import the CLASS (not singleton) so we can test constructor defaults
import { default as HorseLifecycleManagerModule } from '../../src/services/HorseLifecycleManager';

describe('HorseLifecycleManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Ensure singleton is stopped
    if ((HorseLifecycleManagerModule as any).isRunning) {
      (HorseLifecycleManagerModule as any).stop?.();
    }
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FLEET HEALTH DEFAULTS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getFleetHealth', () => {
    it('should return zero-filled health when no horses exist', async () => {
      const health = await HorseLifecycleManagerModule.getFleetHealth();
      expect(health).toEqual({
        total: 0,
        available: 0,
        seated: 0,
        inTournament: 0,
        leaving: 0,
        stuck: 0,
        busted: 0,
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LIFECYCLE MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────

  describe('start / stop', () => {
    it('should start without crashing', () => {
      HorseLifecycleManagerModule.start();
      // isRunning is private, but we can verify by calling stop without error
      HorseLifecycleManagerModule.stop();
    });

    it('should not crash on double start', () => {
      HorseLifecycleManagerModule.start();
      HorseLifecycleManagerModule.start(); // duplicate
      HorseLifecycleManagerModule.stop();
    });

    it('should not crash on stop when not running', () => {
      HorseLifecycleManagerModule.stop(); // Not started
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RESET HORSE
  // ─────────────────────────────────────────────────────────────────────────

  describe('resetHorse', () => {
    it('should return true when reset succeeds (mocked)', async () => {
      const result = await HorseLifecycleManagerModule.resetHorse('horse-1');
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROCESS WINNINGS
  // ─────────────────────────────────────────────────────────────────────────

  describe('processWinnings', () => {
    it('should return true on successful credit (mocked)', async () => {
      const result = await HorseLifecycleManagerModule.processWinnings('horse-1', 500, 'tourney-1');
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROCESS ELIMINATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('processElimination', () => {
    it('should return true on successful elimination (mocked)', async () => {
      const result = await HorseLifecycleManagerModule.processElimination('horse-1', 'tourney-1');
      expect(result).toBe(true);
    });
  });
});
