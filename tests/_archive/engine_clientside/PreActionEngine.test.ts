/**
 * ♠ CLUB ARENA — PreActionEngine Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests the queuing and execution of pre-actions (auto-fold, auto-call, etc.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), on: vi.fn(), subscribe: vi.fn(), subscribeDebounced: vi.fn() },
}));

import { preActionEngine } from '../../src/engine/PreActionEngine';
import { masterBus } from '../../src/core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════

describe('PreActionEngine - Set/Get/Clear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preActionEngine.dispose('tbl-1');
  });

  it('should set and get pre-action', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_fold');
    expect(preActionEngine.hasPreAction('tbl-1', 'p1')).toBe(true);

    const entry = preActionEngine.getPreAction('tbl-1', 'p1');
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe('auto_fold');
  });

  it('should clear pre-action', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_fold');
    preActionEngine.clearPreAction('tbl-1', 'p1');
    expect(preActionEngine.hasPreAction('tbl-1', 'p1')).toBe(false);
  });

  it('should emit PRE_ACTION_SET event', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_call', 100);
    expect(masterBus.emit).toHaveBeenCalledWith(
      'PRE_ACTION_SET',
      expect.objectContaining({ tableId: 'tbl-1', playerId: 'p1', action: 'auto_call' })
    );
  });
});

describe('PreActionEngine - Execution (auto_fold)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preActionEngine.dispose('tbl-1');
  });

  it('should always fold', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_fold');

    // Even if they can check
    const result = preActionEngine.executePreAction('tbl-1', 'p1', true, 0, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('fold');
    expect(preActionEngine.hasPreAction('tbl-1', 'p1')).toBe(false); // Cleared after exec
  });
});

describe('PreActionEngine - Execution (auto_check_fold)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preActionEngine.dispose('tbl-1');
  });

  it('should check if canCheck is true', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_check_fold');
    const result = preActionEngine.executePreAction('tbl-1', 'p1', true, 0, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('check');
  });

  it('should fold if canCheck is false (bet exists)', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_check_fold');
    const result = preActionEngine.executePreAction('tbl-1', 'p1', false, 50, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('fold');
  });
});

describe('PreActionEngine - Execution (auto_check)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preActionEngine.dispose('tbl-1');
  });

  it('should check if canCheck is true', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_check');
    const result = preActionEngine.executePreAction('tbl-1', 'p1', true, 0, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('check');
  });

  // Note: normally auto_check is cleared by onBetPlaced before execution,
  // but if somehow it executes while canCheck is false, it should invalidate.
  it('should invalidate if executed when check is impossible', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_check');
    const result = preActionEngine.executePreAction('tbl-1', 'p1', false, 50, 1000);

    expect(result.executed).toBe(false);
    expect(result.invalidated).toBe(true);
  });
});

describe('PreActionEngine - Execution (auto_call)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preActionEngine.dispose('tbl-1');
  });

  it('should check if canCheck is true', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_call');
    const result = preActionEngine.executePreAction('tbl-1', 'p1', true, 0, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('check');
  });

  it('should call if amount is <= stack', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_call');
    const result = preActionEngine.executePreAction('tbl-1', 'p1', false, 50, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('call');
    expect(result.amount).toBe(50);
  });

  it('should all-in call if amount > stack', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_call');
    const result = preActionEngine.executePreAction('tbl-1', 'p1', false, 2000, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('call');
    expect(result.amount).toBe(1000); // Caps at stack
  });

  it('should invalidate if amount > maxCallAmount', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_call', 50); // Max 50
    const result = preActionEngine.executePreAction('tbl-1', 'p1', false, 100, 1000);

    expect(result.executed).toBe(false);
    expect(result.invalidated).toBe(true);
  });
});

describe('PreActionEngine - Execution (auto_call_any)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preActionEngine.dispose('tbl-1');
  });

  it('should call any amount, capped at stack', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_call_any');
    const result = preActionEngine.executePreAction('tbl-1', 'p1', false, 5000, 1000);

    expect(result.executed).toBe(true);
    expect(result.action).toBe('call');
    expect(result.amount).toBe(1000);
  });
});

describe('PreActionEngine - Invalidation & Cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preActionEngine.dispose('tbl-1');
  });

  it('should invalidate auto_check when bet placed', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_check');
    preActionEngine.setPreAction('tbl-1', 'p2', 'auto_check');

    // p2 places a bet
    preActionEngine.onBetPlaced('tbl-1', 'p2');

    // p1's auto_check should be removed since someone else bet
    expect(preActionEngine.hasPreAction('tbl-1', 'p1')).toBe(false);

    // p2's auto_check should remain because they are the one who bet (so it won't clear their own action, though typically they wouldn't have one queued while betting)
    expect(preActionEngine.hasPreAction('tbl-1', 'p2')).toBe(true);

    expect(masterBus.emit).toHaveBeenCalledWith(
      'PRE_ACTION_INVALIDATED',
      expect.objectContaining({ playerId: 'p1' })
    );
  });

  it('should clear all pre-actions for a table', () => {
    preActionEngine.setPreAction('tbl-1', 'p1', 'auto_fold');
    preActionEngine.setPreAction('tbl-1', 'p2', 'auto_call');

    preActionEngine.clearTable('tbl-1');

    expect(preActionEngine.hasPreAction('tbl-1', 'p1')).toBe(false);
    expect(preActionEngine.hasPreAction('tbl-1', 'p2')).toBe(false);
  });
});
