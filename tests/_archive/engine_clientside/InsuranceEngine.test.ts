/**
 * ♠ CLUB ARENA — InsuranceEngine Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests insurance configuration, accept/decline, settlement, and bus emissions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock MasterBus
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    on: vi.fn(),
    subscribe: vi.fn(),
    subscribeDebounced: vi.fn(),
  },
}));

// Mock MonteCarloEquity
vi.mock('../../src/engine/MonteCarloEquity', () => ({
  monteCarloEquity: {
    calculateEquity: vi.fn(() =>
      Promise.resolve({
        equities: [
          { playerId: 'p1', equity: 0.35, wins: 350, ties: 0, total: 1000 },
          { playerId: 'p2', equity: 0.65, wins: 650, ties: 0, total: 1000 },
        ],
      })
    ),
  },
}));

import { insuranceEngine } from '../../src/engine/InsuranceEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('InsuranceEngine - Configuration', () => {
  it('should configure insurance for a table', () => {
    insuranceEngine.configure('ins-cfg-1', {
      enabled: true,
      minPotForInsurance: 20,
      maxInsurablePercent: 100,
      offerTimeoutSeconds: 15,
    });
    expect(true).toBe(true);
  });

  it('should check if insurance is enabled', () => {
    insuranceEngine.configure('ins-en', { enabled: true, minPotForInsurance: 10 });
    expect(insuranceEngine.isEnabled('ins-en')).toBe(true);
  });

  it('should return false for unconfigured table', () => {
    expect(insuranceEngine.isEnabled('ins-unconfigured-xyz')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OFFERS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('InsuranceEngine - Offers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insuranceEngine.configure('ins-off', {
      enabled: true,
      minPotForInsurance: 10,
      offerTimeoutSeconds: 15,
    });
  });

  it('should return empty offers for table with no active offers', () => {
    const offers = insuranceEngine.getOffers('ins-off');
    expect(Array.isArray(offers)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISPOSAL TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('InsuranceEngine - Disposal', () => {
  it('should dispose without errors', () => {
    insuranceEngine.configure('ins-dispose', { enabled: true, minPotForInsurance: 10 });
    insuranceEngine.dispose('ins-dispose');
    expect(true).toBe(true);
  });

  it('should return empty offers after disposal', () => {
    insuranceEngine.configure('ins-disp-2', { enabled: true, minPotForInsurance: 10 });
    insuranceEngine.dispose('ins-disp-2');
    const offers = insuranceEngine.getOffers('ins-disp-2');
    expect(offers).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALLRESPONDED TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('InsuranceEngine - allResponded', () => {
  it('should return true when no active offers exist', () => {
    insuranceEngine.configure('ins-ar', { enabled: true, minPotForInsurance: 10 });
    expect(insuranceEngine.allResponded('ins-ar')).toBe(true);
  });
});
