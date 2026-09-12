/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — Performance Benchmarks
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verifies that critical synchronous functions execute within acceptable time.
 * These are NOT tests against network/DB latency — only pure computation.
 */

import { describe, it, expect, vi } from 'vitest';

// Isolate the canonical identity boundary; these tests do not bootstrap authentication.
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({ loaded: true, authenticated: false, userId: null }),
}));

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

/**
 * MEASURE THE CODE, NOT THE MACHINE (2026-09-02).
 *
 * These benchmarks exist to catch an accidental network call or an O(n^2)
 * blow-up in a hot synchronous path - failures that are orders of magnitude,
 * not percentages. A single wall-clock sample cannot tell those apart from a
 * busy CPU. CI moved to a shared 8-core box running eight jobs at once, and
 * `getMilestones` measured 123ms against a 100ms bar, then 138ms, on code
 * that had not changed: the one red test in 11,400, blocking merges for
 * every agent. (The suite is green on an idle laptop at ~10ms.)
 *
 * Fix: time the loop several times and judge the FASTEST run. Contention is
 * bursty - it inflates a mean but almost never lands on every sample - so the
 * minimum tracks the code's real cost on that machine. The bars carry a 2x
 * margin for the same reason; a regression this test is meant to catch is
 * 10x-1000x, so the margin costs nothing it was ever going to detect.
 */
const RUNS = 7;
const ITERATIONS = 10_000;

function fastestOf(runs: number, body: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    body();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('Performance Benchmarks', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // SYNCHRONOUS COMPUTATIONS
  // ─────────────────────────────────────────────────────────────────────────

  describe('CreditService.calculateStatus', () => {
    it('should complete 10,000 calls in < 100ms (fastest of 7)', () => {
      const best = fastestOf(RUNS, () => {
        for (let i = 0; i < ITERATIONS; i++) {
          CreditService.calculateStatus(i % 120);
        }
      });
      expect(best).toBeLessThan(100);
    });
  });

  describe('ReferralService.getMilestones', () => {
    it('should complete 10,000 calls in < 200ms (fastest of 7)', () => {
      const best = fastestOf(RUNS, () => {
        for (let i = 0; i < ITERATIONS; i++) {
          referralService.getMilestones(i);
        }
      });
      expect(best).toBeLessThan(200);
    });
  });
});
