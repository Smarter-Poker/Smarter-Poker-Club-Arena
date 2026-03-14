/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SettlementCronService
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies (no top-level variable references) ─────────────────

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
    from: () => buildChain(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/services/SettlementService', () => ({
  SettlementService: {
    getCurrentPeriod: vi.fn().mockResolvedValue({
      id: 'period-1',
      status: 'open',
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 86400000).toISOString(),
    }),
    closePeriod: vi.fn().mockResolvedValue(undefined),
    executeMondayPayouts: vi.fn().mockResolvedValue({
      agentsPaid: 5,
      playersWithRakeback: 10,
      totalDisbursed: 5000,
    }),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: {
    raise: vi.fn(),
    logCritical: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { SettlementCronService } from '../../src/services/SettlementCronService';

describe('SettlementCronService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    SettlementCronService.stop();
    SettlementCronService.checksPerformed = 0;
    SettlementCronService.lastCheckAt = 0;
    SettlementCronService.isRunning = false;
  });

  afterEach(() => {
    SettlementCronService.stop();
    vi.useRealTimers();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FORMAT COUNTDOWN
  // ─────────────────────────────────────────────────────────────────────────

  describe('formatCountdown', () => {
    it('should return "NOW" for past dates', () => {
      const past = new Date(Date.now() - 1000);
      expect(SettlementCronService.formatCountdown(past)).toBe('NOW');
    });

    it('should format hours and minutes', () => {
      const target = new Date(Date.now() + 5 * 60 * 60 * 1000 + 30 * 60 * 1000);
      const result = SettlementCronService.formatCountdown(target);
      expect(result).toBe('5h 30m');
    });

    it('should format days when >= 24 hours', () => {
      const target = new Date(Date.now() + 50 * 60 * 60 * 1000);
      const result = SettlementCronService.formatCountdown(target);
      expect(result).toBe('2d 2h');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET NEXT SUNDAY SNAPSHOT
  // ─────────────────────────────────────────────────────────────────────────

  describe('getNextSundaySnapshot', () => {
    it('should return a Sunday', () => {
      const next = SettlementCronService.getNextSundaySnapshot();
      expect(next.getDay()).toBe(0);
    });

    it('should be set to 23:59:59', () => {
      const next = SettlementCronService.getNextSundaySnapshot();
      expect(next.getHours()).toBe(23);
      expect(next.getMinutes()).toBe(59);
      expect(next.getSeconds()).toBe(59);
    });

    it('should be in the future', () => {
      const next = SettlementCronService.getNextSundaySnapshot();
      expect(next.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET NEXT MONDAY PAYOUT
  // ─────────────────────────────────────────────────────────────────────────

  describe('getNextMondayPayout', () => {
    it('should return a Monday', () => {
      const next = SettlementCronService.getNextMondayPayout();
      expect(next.getDay()).toBe(1);
    });

    it('should be set to 4:00 AM', () => {
      const next = SettlementCronService.getNextMondayPayout();
      expect(next.getHours()).toBe(4);
      expect(next.getMinutes()).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET STATUS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('should report not running when stopped', () => {
      const status = SettlementCronService.getStatus();
      expect(status.isRunning).toBe(false);
      expect(status.checksPerformed).toBe(0);
    });

    it('should include nextSnapshotAt and nextPayoutAt', () => {
      const status = SettlementCronService.getStatus();
      expect(status.nextSnapshotAt).toBeDefined();
      expect(status.nextPayoutAt).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────

  describe('start / stop', () => {
    it('should set timer on start and clear on stop', () => {
      SettlementCronService.start({ checkIntervalMs: 60000 });
      expect(SettlementCronService.timer).not.toBeNull();
      SettlementCronService.stop();
      expect(SettlementCronService.timer).toBeNull();
    });

    it('should stop previous timer on double-start', () => {
      SettlementCronService.start({ checkIntervalMs: 60000 });
      const firstTimer = SettlementCronService.timer;
      SettlementCronService.start({ checkIntervalMs: 30000 });
      expect(SettlementCronService.timer).not.toBe(firstTimer);
    });
  });
});
