/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — Performance Benchmarks
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verifies that critical synchronous functions execute within acceptable time.
 * These are NOT tests against network/DB latency — only pure computation.
 */

import { describe, it, expect, vi } from 'vitest';

// ─── Mock dependencies (needed for imports) ───────────────────────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
      }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    subscribeDebounced: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: { getBalance: vi.fn(), logTransaction: vi.fn() },
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: { logWarning: vi.fn(), logCritical: vi.fn() },
}));

vi.mock('../../src/services/SettlementService', () => ({
  SettlementService: {},
}));

// ─── Imports ──────────────────────────────────────────────────────────────

import { CreditService } from '../../src/services/CreditService';
import { referralService } from '../../src/services/ReferralService';

describe('Performance Benchmarks', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // SYNCHRONOUS COMPUTATIONS
  // ─────────────────────────────────────────────────────────────────────────

  describe('CreditService.calculateStatus', () => {
    it('should complete 10,000 calls in < 50ms', () => {
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        CreditService.calculateStatus(i % 120);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('ReferralService.getMilestones', () => {
    it('should complete 10,000 calls in < 100ms', () => {
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        referralService.getMilestones(i);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });
});
