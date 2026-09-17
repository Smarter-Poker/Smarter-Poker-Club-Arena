/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ServiceBootstrap
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests bootServices idempotency, shutdownServices, and BootResult shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn() },
}));

vi.mock('../../src/services/OfflineQueueService', () => ({
  OfflineQueueService: {
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  },
}));

vi.mock('../../src/services/SettlementCronService', () => ({
  SettlementCronService: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../src/services/AutoRebuyService', () => ({
  AutoRebuyService: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../src/services/FinancialCronService', () => ({
  FinancialCronService: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { bootServices, shutdownServices } from '../../src/services/ServiceBootstrap';
import { OfflineQueueService } from '../../src/services/OfflineQueueService';
import { SettlementCronService } from '../../src/services/SettlementCronService';
import { FinancialCronService } from '../../src/services/FinancialCronService';

describe('ServiceBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset booted state
    shutdownServices();
  });

  describe('bootServices', () => {
    it('does not open the game-engine socket on every authenticated route', () => {
      const source = readFileSync(
        resolve(__dirname, '../../src/services/ServiceBootstrap.ts'),
        'utf8'
      );
      expect(source).toContain("import('../lib/authToken')");
      expect(source).toContain('initAuthTokenCache();');
      expect(source).not.toContain('engineSocketMux.prewarm(');
      expect(source).not.toContain("engineSocketUrl(this.baseUrl, '/ws/multi')");
    });

    it('should return BootResult with timestamp', async () => {
      const result = await bootServices();
      expect(result.timestamp).toBeTruthy();
      expect(typeof result.offlineQueue).toBe('boolean');
      expect(typeof result.settlementCron).toBe('boolean');
      expect(typeof result.autoRebuy).toBe('boolean');
      expect(typeof result.financialCron).toBe('boolean');
    });

    it('should mark offlineQueue as true on success', async () => {
      const result = await bootServices();
      expect(result.offlineQueue).toBe(true);
    });

    it('should be idempotent (second call returns early)', async () => {
      const first = await bootServices();
      const second = await bootServices();
      expect(first.offlineQueue).toBe(true);
      expect(second.offlineQueue).toBe(true);
    });

    it('never starts a browser payer even for the retired opt-in', async () => {
      const result = await bootServices({ enableSettlementCron: true });
      const repeated = await bootServices({ enableSettlementCron: true });
      expect(result.settlementCron).toBe(false);
      expect(repeated).toEqual(result);
      expect(SettlementCronService.start).not.toHaveBeenCalled();
    });

    it('retains actual startup failures on repeat instead of manufacturing healthy services', async () => {
      vi.mocked(OfflineQueueService.init).mockRejectedValueOnce(new Error('unavailable'));
      vi.mocked(FinancialCronService.start).mockImplementationOnce(() => {
        throw new Error('unavailable');
      });
      const first = await bootServices();
      first.offlineQueue = true; // A caller cannot mutate the cached observation.
      const repeated = await bootServices();
      expect(repeated.offlineQueue).toBe(false);
      expect(repeated.financialCron).toBe(false);
      expect(repeated.settlementCron).toBe(false);
      expect(OfflineQueueService.init).toHaveBeenCalledTimes(1);
      expect(FinancialCronService.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdownServices', () => {
    it('should not crash on shutdown', () => {
      shutdownServices();
    });

    it('should allow re-boot after shutdown', async () => {
      await bootServices();
      shutdownServices();
      const result = await bootServices();
      expect(result.offlineQueue).toBe(true);
    });
  });
});
