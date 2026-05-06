/**
 * ♠ CLUB ARENA — PayoutEngine Tests (Tournament Prize Distribution)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests payout template selection, amount calculation, and prize distribution.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock MasterBus
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    on: vi.fn(),
    subscribe: vi.fn(),
    subscribeDebounced: vi.fn(),
  },
}));

// Mock Supabase
vi.mock('../../src/services/supabaseClient', () => ({
  getSupabase: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ single: vi.fn(() => ({ data: null, error: null })) })),
      })),
      update: vi.fn(() => ({ eq: vi.fn(() => ({ data: null, error: null })) })),
      insert: vi.fn(() => ({ data: null, error: null })),
    })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
  })),
}));

import { payoutEngine } from '../../src/services/PayoutEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-SELECT PAYOUT TEMPLATE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('PayoutEngine - autoSelectPayouts', () => {
  it('should return payout entries for 3 players', () => {
    const payouts = payoutEngine.autoSelectPayouts(3);

    expect(payouts).toBeDefined();
    expect(Array.isArray(payouts)).toBe(true);
    expect(payouts.length).toBeGreaterThanOrEqual(1);
  });

  it('should return payout entries for 6 players', () => {
    const payouts = payoutEngine.autoSelectPayouts(6);
    expect(payouts.length).toBeGreaterThanOrEqual(2);
  });

  it('should return payout entries for 9 players', () => {
    const payouts = payoutEngine.autoSelectPayouts(9);
    expect(payouts.length).toBeGreaterThanOrEqual(3);
  });

  it('should return descending percentages', () => {
    const payouts = payoutEngine.autoSelectPayouts(9);

    for (let i = 1; i < payouts.length; i++) {
      expect(payouts[i - 1].percentage).toBeGreaterThanOrEqual(payouts[i].percentage);
    }
  });

  it('payout percentages should sum to ~100', () => {
    for (const count of [3, 6, 9]) {
      const payouts = payoutEngine.autoSelectPayouts(count);
      const totalPercent = payouts.reduce((sum, p) => sum + p.percentage, 0);
      expect(totalPercent).toBeCloseTo(100, 0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CALCULATE AMOUNTS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('PayoutEngine - calculateAmounts', () => {
  it('should calculate correct amounts from percentages and prize pool', () => {
    const payouts = payoutEngine.autoSelectPayouts(3);
    const calculated = payoutEngine.calculateAmounts(payouts, 1000);

    expect(calculated).toBeDefined();
    expect(calculated.length).toBe(payouts.length);

    for (const entry of calculated) {
      expect(entry.amount).toBeGreaterThanOrEqual(0);
    }
  });

  it('total amounts should equal prize pool', () => {
    const payouts = payoutEngine.autoSelectPayouts(6);
    const calculated = payoutEngine.calculateAmounts(payouts, 3000);

    const totalPaid = calculated.reduce((sum, p) => sum + (p.amount ?? 0), 0);
    expect(totalPaid).toBeCloseTo(3000, 0);
  });

  it('should handle fractional chip payouts', () => {
    const payouts = payoutEngine.autoSelectPayouts(3);
    const calculated = payoutEngine.calculateAmounts(payouts, 100.5);

    const totalPaid = calculated.reduce((sum, p) => sum + (p.amount ?? 0), 0);
    // Allow ±1 chip tolerance for rounding
    expect(Math.abs(totalPaid - 100.5)).toBeLessThan(1);
  });

  it('first place should get the largest payout', () => {
    const payouts = payoutEngine.autoSelectPayouts(6);
    const calculated = payoutEngine.calculateAmounts(payouts, 5000);

    if (calculated.length >= 2) {
      expect(calculated[0].amount!).toBeGreaterThanOrEqual(calculated[1].amount!);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NORMALIZE PAYOUTS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('PayoutEngine - normalizePayouts', () => {
  it('should normalize payouts to sum to 100%', () => {
    const input = [
      { place: 1, percentage: 60 },
      { place: 2, percentage: 30 },
      { place: 3, percentage: 20 },
    ];

    const normalized = payoutEngine.normalizePayouts(input);
    const totalPercent = normalized.reduce((sum, p) => sum + p.percentage, 0);
    expect(totalPercent).toBeCloseTo(100, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('PayoutEngine - Edge Cases', () => {
  it('should handle zero prize pool gracefully', () => {
    const payouts = payoutEngine.autoSelectPayouts(3);
    const calculated = payoutEngine.calculateAmounts(payouts, 0);

    const totalPaid = calculated.reduce((sum, p) => sum + (p.amount ?? 0), 0);
    expect(totalPaid).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE OPTIONS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('PayoutEngine - Template Options', () => {
  it('should return available template options', () => {
    const options = payoutEngine.getTemplateOptions();
    expect(Array.isArray(options)).toBe(true);
    expect(options.length).toBeGreaterThan(0);

    for (const opt of options) {
      expect(opt.value).toBeDefined();
      expect(opt.label).toBeDefined();
    }
  });
});
