/**
 * ♠ CLUB ARENA — ServerActionValidator Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests poker action validation: fold, check, call, bet, raise, all-in,
 * turn order, timing, duplicate suppression, and amount bounds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), on: vi.fn(), subscribe: vi.fn(), subscribeDebounced: vi.fn() },
}));

import { serverActionValidator } from '../../src/engine/ServerActionValidator';
import type { ActionRequest, ValidationContext } from '../../src/engine/ServerActionValidator';

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    tableId: 'tbl-1',
    handId: 'h-1',
    playerId: 'p1',
    action: 'fold',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    currentPlayerId: 'p1',
    stage: 'flop',
    currentBet: 0,
    playerBet: 0,
    playerStack: 1000,
    bigBlind: 10,
    minRaise: 10,
    pot: 25,
    canCheck: true,
    actionDeadline: Date.now() + 30000,
    playerActedThisRound: false,
    isAllIn: false,
    isFolded: false,
    numActivePlayers: 3,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('ServerActionValidator - Fold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should always allow fold', () => {
    const result = serverActionValidator.validate(makeRequest({ action: 'fold' }), makeContext());
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('fold');
  });

  it('should allow fold even when check is available', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'fold' }),
      makeContext({ canCheck: true })
    );
    expect(result.valid).toBe(true);
  });
});

describe('ServerActionValidator - Check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should allow check when canCheck is true', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'check' }),
      makeContext({ canCheck: true })
    );
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('check');
  });

  it('should reject check when canCheck is false', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'check' }),
      makeContext({ canCheck: false })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('CANNOT_CHECK');
  });
});

describe('ServerActionValidator - Call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should allow call with correct sanitized amount', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'call' }),
      makeContext({ currentBet: 20, playerBet: 0, canCheck: false })
    );
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('call');
    expect(result.sanitizedAmount).toBe(20);
  });

  it('should convert call to all_in when insufficient stack', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'call' }),
      makeContext({ currentBet: 2000, playerBet: 0, playerStack: 500, canCheck: false })
    );
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('all_in');
    expect(result.sanitizedAmount).toBe(500);
  });

  it('should reject call when nothing to call', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'call' }),
      makeContext({ currentBet: 0, playerBet: 0 })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('NOTHING_TO_CALL');
  });
});

describe('ServerActionValidator - Bet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should allow valid bet', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'bet', amount: 20 }),
      makeContext({ currentBet: 0, bigBlind: 10 })
    );
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('bet');
    expect(result.sanitizedAmount).toBe(20);
  });

  it('should reject bet when there is already a bet', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'bet', amount: 20 }),
      makeContext({ currentBet: 10, canCheck: false })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('INVALID_ACTION');
  });

  it('should reject bet below minimum (big blind)', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'bet', amount: 5 }),
      makeContext({ currentBet: 0, bigBlind: 10 })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('BELOW_MIN_RAISE');
  });

  it('should convert bet to all_in when amount >= stack', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'bet', amount: 1500 }),
      makeContext({ currentBet: 0, playerStack: 1000 })
    );
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('all_in');
    expect(result.sanitizedAmount).toBe(1000);
  });

  it('should reject bet with no amount', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'bet' }),
      makeContext({ currentBet: 0 })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('INVALID_AMOUNT');
  });
});

describe('ServerActionValidator - Raise', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should allow valid raise', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'raise', amount: 40 }),
      makeContext({ currentBet: 20, playerBet: 0, minRaise: 20, canCheck: false })
    );
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('raise');
    expect(result.sanitizedAmount).toBe(40);
  });

  it('should reject raise when no bet exists', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'raise', amount: 30 }),
      makeContext({ currentBet: 0 })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('INVALID_ACTION');
  });

  it('should reject raise below minimum', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'raise', amount: 25 }),
      makeContext({ currentBet: 20, minRaise: 20, canCheck: false })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('BELOW_MIN_RAISE');
  });

  it('should convert raise to all_in when exceeds stack', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'raise', amount: 2000 }),
      makeContext({ currentBet: 20, playerBet: 0, playerStack: 500, minRaise: 20, canCheck: false })
    );
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('all_in');
    expect(result.sanitizedAmount).toBe(500);
  });
});

describe('ServerActionValidator - All-In', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should allow all_in with remaining stack', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'all_in' }),
      makeContext({ playerStack: 500 })
    );
    expect(result.valid).toBe(true);
    expect(result.sanitizedAction).toBe('all_in');
    expect(result.sanitizedAmount).toBe(500);
  });

  it('should reject all_in with zero stack', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'all_in' }),
      makeContext({ playerStack: 0 })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('INSUFFICIENT_STACK');
  });
});

describe('ServerActionValidator - Turn Order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should reject action from wrong player', () => {
    const result = serverActionValidator.validate(
      makeRequest({ playerId: 'p2' }),
      makeContext({ currentPlayerId: 'p1' })
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('NOT_YOUR_TURN');
  });
});

describe('ServerActionValidator - Player State', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should reject if player already folded', () => {
    const result = serverActionValidator.validate(makeRequest(), makeContext({ isFolded: true }));
    expect(result.valid).toBe(false);
    expect(result.code).toBe('ALREADY_FOLDED');
  });

  it('should reject if player already all-in', () => {
    const result = serverActionValidator.validate(makeRequest(), makeContext({ isAllIn: true }));
    expect(result.valid).toBe(false);
    expect(result.code).toBe('ALREADY_ALL_IN');
  });
});

describe('ServerActionValidator - Timing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should reject expired actions (beyond grace period)', () => {
    const result = serverActionValidator.validate(
      makeRequest({ timestamp: Date.now() }),
      makeContext({ actionDeadline: Date.now() - 5000 }) // Expired 5s ago
    );
    expect(result.valid).toBe(false);
    expect(result.code).toBe('ACTION_EXPIRED');
  });

  it('should allow actions within grace period', () => {
    const result = serverActionValidator.validate(
      makeRequest({ action: 'fold' }),
      makeContext({ actionDeadline: Date.now() - 1000 }) // 1s ago, within 2s grace
    );
    expect(result.valid).toBe(true);
  });
});

describe('ServerActionValidator - Duplicate Suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should reject duplicate identical actions', () => {
    const ts = Date.now();
    const req = makeRequest({ action: 'fold', timestamp: ts });
    const ctx = makeContext();

    serverActionValidator.validate(req, ctx); // First (accepted)
    const second = serverActionValidator.validate(req, ctx); // Second (duplicate)

    expect(second.valid).toBe(false);
    expect(second.code).toBe('ALREADY_ACTED');
  });
});

describe('ServerActionValidator - Cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverActionValidator.dispose();
  });

  it('should clear table state on clearTable', () => {
    serverActionValidator.validate(makeRequest(), makeContext());
    serverActionValidator.clearTable('tbl-1');
    // After clearing, same action should be accepted again (not duplicate)
    const result = serverActionValidator.validate(makeRequest(), makeContext());
    expect(result.valid).toBe(true);
  });
});
