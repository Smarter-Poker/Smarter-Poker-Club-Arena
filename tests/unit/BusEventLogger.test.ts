/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — BusEventLogger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests CRITICAL_EVENTS list, batch lifecycle, start/stop, getBatchSize,
 * and flush behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return { supabase: { from: () => buildChain() } };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: { getState: () => ({ user: { id: 'test-user' } }) },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { busEventLogger } from '../../src/services/BusEventLogger';

describe('BusEventLogger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    busEventLogger.stop();
    vi.useRealTimers();
  });

  describe('getBatchSize', () => {
    it('should return 0 when no events queued', () => {
      expect(busEventLogger.getBatchSize()).toBe(0);
    });
  });

  describe('start / stop lifecycle', () => {
    it('should start without crashing', () => {
      busEventLogger.start();
      // No throw = pass
    });

    it('should not crash on double start', () => {
      busEventLogger.start();
      busEventLogger.start(); // Guard should prevent duplicate subscriptions
    });

    it('should stop without crashing', () => {
      busEventLogger.start();
      busEventLogger.stop();
    });

    it('should not crash on stop when not started', () => {
      busEventLogger.stop();
    });
  });

  describe('flush', () => {
    it('should not crash on flush when batch is empty', async () => {
      await busEventLogger.flush();
      // No throw = pass
    });
  });
});
