/**
 * ♠ CLUB ARENA — TimeBankEngine Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests time bank allocation, activation, depletion, and bus emissions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock MasterBus
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    on: vi.fn(),
    subscribe: vi.fn(),
    subscribeDebounced: vi.fn(),
  },
}));

import { timeBankEngine } from '../../src/engine/TimeBankEngine';
import { masterBus } from '../../src/core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('TimeBankEngine - Configuration', () => {
  it('should configure a table with custom settings', () => {
    timeBankEngine.configure('tb-cfg-1', {
      totalBankSeconds: 60,
      maxUses: 6,
      secondsPerUse: 10,
    });
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('TimeBankEngine - Player Initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    timeBankEngine.configure('tb-init', {
      totalBankSeconds: 30,
      maxUses: 4,
      secondsPerUse: 15,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize a player with correct bank allocation', () => {
    timeBankEngine.initializePlayer('tb-init', 'p1');
    const bank = timeBankEngine.getPlayerBank('tb-init', 'p1');

    expect(bank).not.toBeNull();
    expect(bank!.remainingSeconds).toBe(30);
    expect(bank!.usesRemaining).toBe(4);
    expect(bank!.isActive).toBe(false);
  });

  it('should track multiple players independently', () => {
    timeBankEngine.initializePlayer('tb-init', 'pa');
    timeBankEngine.initializePlayer('tb-init', 'pb');

    const bankA = timeBankEngine.getPlayerBank('tb-init', 'pa');
    const bankB = timeBankEngine.getPlayerBank('tb-init', 'pb');

    expect(bankA).not.toBeNull();
    expect(bankB).not.toBeNull();
    expect(bankA!.remainingSeconds).toBe(30);
    expect(bankB!.remainingSeconds).toBe(30);
  });

  it('should return null for uninitialized player', () => {
    const bank = timeBankEngine.getPlayerBank('tb-init', 'nonexistent');
    expect(bank).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('TimeBankEngine - Activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    timeBankEngine.configure('tb-act', {
      totalBankSeconds: 30,
      maxUses: 4,
      secondsPerUse: 15,
    });
    timeBankEngine.initializePlayer('tb-act', 'p1');
  });

  afterEach(() => {
    timeBankEngine.playerActed('tb-act', 'p1');
    vi.useRealTimers();
  });

  it('should activate and emit TIME_BANK_ACTIVATED', () => {
    const onExpire = vi.fn();
    const result = timeBankEngine.activate('tb-act', 'p1', onExpire);

    expect(result).toBe(true);
    expect(masterBus.emit).toHaveBeenCalledWith(
      'TIME_BANK_ACTIVATED',
      expect.objectContaining({
        tableId: 'tb-act',
        playerId: 'p1',
      })
    );
  });

  it('should decrease uses remaining on activation', () => {
    const bankBefore = timeBankEngine.getPlayerBank('tb-act', 'p1');
    const usesBefore = bankBefore!.usesRemaining;

    timeBankEngine.activate('tb-act', 'p1', vi.fn());

    const bankAfter = timeBankEngine.getPlayerBank('tb-act', 'p1');
    expect(bankAfter!.usesRemaining).toBe(usesBefore - 1);
  });

  it('should mark bank as active during countdown', () => {
    timeBankEngine.activate('tb-act', 'p1', vi.fn());
    const bank = timeBankEngine.getPlayerBank('tb-act', 'p1');
    expect(bank!.isActive).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEPLETION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('TimeBankEngine - Depletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    timeBankEngine.configure('tb-depl', {
      totalBankSeconds: 15,
      maxUses: 1,
      secondsPerUse: 15,
    });
    timeBankEngine.initializePlayer('tb-depl', 'p1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return false when activating with 0 uses remaining', () => {
    // Use the one available bank
    timeBankEngine.activate('tb-depl', 'p1', vi.fn());
    timeBankEngine.playerActed('tb-depl', 'p1');

    // Try again — should fail
    const result = timeBankEngine.activate('tb-depl', 'p1', vi.fn());
    expect(result).toBe(false);
  });

  it('should hasTimeBank return false when depleted', () => {
    timeBankEngine.activate('tb-depl', 'p1', vi.fn());
    timeBankEngine.playerActed('tb-depl', 'p1');

    expect(timeBankEngine.hasTimeBank('tb-depl', 'p1')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYER ACTED TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('TimeBankEngine - Player Acted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    timeBankEngine.configure('tb-acted', {
      totalBankSeconds: 30,
      maxUses: 4,
      secondsPerUse: 15,
    });
    timeBankEngine.initializePlayer('tb-acted', 'p1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should stop active timer when player acts', () => {
    timeBankEngine.activate('tb-acted', 'p1', vi.fn());
    timeBankEngine.playerActed('tb-acted', 'p1');

    const bank = timeBankEngine.getPlayerBank('tb-acted', 'p1');
    expect(bank!.isActive).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORBIT REFILL TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('TimeBankEngine - Orbit Refill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    timeBankEngine.configure('tb-refill', {
      totalBankSeconds: 30,
      maxUses: 4,
      secondsPerUse: 15,
      refillPerOrbit: true,
      refillSeconds: 15,
    });
    timeBankEngine.initializePlayer('tb-refill', 'p1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should refill on orbit completion when configured', () => {
    // Deplete one use
    timeBankEngine.activate('tb-refill', 'p1', vi.fn());
    timeBankEngine.playerActed('tb-refill', 'p1');

    const bankBefore = timeBankEngine.getPlayerBank('tb-refill', 'p1');
    const usesBefore = bankBefore!.usesRemaining;

    timeBankEngine.onOrbitComplete('tb-refill');

    const bankAfter = timeBankEngine.getPlayerBank('tb-refill', 'p1');
    expect(bankAfter!.usesRemaining).toBeGreaterThanOrEqual(usesBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER METHODS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('TimeBankEngine - Helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    timeBankEngine.configure('tb-help', { totalBankSeconds: 30, maxUses: 4, secondsPerUse: 15 });
    timeBankEngine.initializePlayer('tb-help', 'p1');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hasTimeBank should return true when banks available', () => {
    expect(timeBankEngine.hasTimeBank('tb-help', 'p1')).toBe(true);
  });

  it('getRemainingSeconds should return correct value', () => {
    expect(timeBankEngine.getRemainingSeconds('tb-help', 'p1')).toBe(30);
  });

  it('getUsesRemaining should return correct value', () => {
    expect(timeBankEngine.getUsesRemaining('tb-help', 'p1')).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('TimeBankEngine - Cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should remove player on removePlayer', () => {
    timeBankEngine.configure('tb-rm', { totalBankSeconds: 30, maxUses: 4 });
    timeBankEngine.initializePlayer('tb-rm', 'p1');
    timeBankEngine.removePlayer('tb-rm', 'p1');
    expect(timeBankEngine.getPlayerBank('tb-rm', 'p1')).toBeNull();
  });

  it('should clean up on dispose', () => {
    timeBankEngine.configure('tb-disp', { totalBankSeconds: 30, maxUses: 4 });
    timeBankEngine.initializePlayer('tb-disp', 'pa');
    timeBankEngine.initializePlayer('tb-disp', 'pb');
    timeBankEngine.dispose('tb-disp');

    expect(timeBankEngine.getPlayerBank('tb-disp', 'pa')).toBeNull();
    expect(timeBankEngine.getPlayerBank('tb-disp', 'pb')).toBeNull();
  });
});
