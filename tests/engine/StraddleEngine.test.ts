/**
 * ♠ CLUB ARENA — StraddleEngine Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests straddle configuration, auto-straddle, manual straddle, Mississippi,
 * and straddle processing logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), on: vi.fn(), subscribe: vi.fn(), subscribeDebounced: vi.fn() },
}));

import { straddleEngine } from '../../src/engine/StraddleEngine';
import { masterBus } from '../../src/core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════

describe('StraddleEngine - Configuration', () => {
  afterEach(() => straddleEngine.dispose('str-cfg'));

  it('should configure straddle for a table', () => {
    straddleEngine.configure('str-cfg', {
      enabled: true,
      mississippiEnabled: false,
      maxStraddles: 1,
      straddleMultiplier: 2,
    });
    const state = straddleEngine.getState('str-cfg');
    expect(state).not.toBeNull();
    expect(state!.tableId).toBe('str-cfg');
  });
});

describe('StraddleEngine - Auto-Straddle Toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    straddleEngine.configure('str-auto', {
      enabled: true,
      mississippiEnabled: false,
      maxStraddles: 1,
      straddleMultiplier: 2,
    });
  });

  afterEach(() => straddleEngine.dispose('str-auto'));

  it('should enable auto-straddle for a player', () => {
    straddleEngine.toggleAutoStraddle('str-auto', 'p1', true);
    expect(straddleEngine.isAutoStraddleOn('str-auto', 'p1')).toBe(true);
  });

  it('should disable auto-straddle for a player', () => {
    straddleEngine.toggleAutoStraddle('str-auto', 'p1', true);
    straddleEngine.toggleAutoStraddle('str-auto', 'p1', false);
    expect(straddleEngine.isAutoStraddleOn('str-auto', 'p1')).toBe(false);
  });

  it('should emit STRADDLE_TOGGLED on toggle', () => {
    straddleEngine.toggleAutoStraddle('str-auto', 'p1', true);
    expect(masterBus.emit).toHaveBeenCalledWith(
      'STRADDLE_TOGGLED',
      expect.objectContaining({ tableId: 'str-auto', playerId: 'p1', enabled: true })
    );
  });

  it('should return false for non-enrolled player', () => {
    expect(straddleEngine.isAutoStraddleOn('str-auto', 'nobody')).toBe(false);
  });
});

describe('StraddleEngine - processStraddles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    straddleEngine.configure('str-proc', {
      enabled: true,
      mississippiEnabled: false,
      maxStraddles: 1,
      straddleMultiplier: 2,
    });
  });

  afterEach(() => straddleEngine.dispose('str-proc'));

  it('should post straddle for enrolled UTG player', () => {
    straddleEngine.toggleAutoStraddle('str-proc', 'p1', true);

    const result = straddleEngine.processStraddles(
      'str-proc',
      10,
      [
        { seat: 3, playerId: 'p1' },
        { seat: 4, playerId: 'p2' },
      ],
      new Map([
        ['p1', 1000],
        ['p2', 1000],
      ])
    );

    expect(result.posted).toBe(true);
    expect(result.straddles).toHaveLength(1);
    expect(result.straddles[0].amount).toBe(20); // 10 * 2
    expect(result.adjustedBigBlind).toBe(20);
  });

  it('should not straddle if not enrolled', () => {
    const result = straddleEngine.processStraddles(
      'str-proc',
      10,
      [{ seat: 3, playerId: 'p1' }],
      new Map([['p1', 1000]])
    );

    expect(result.posted).toBe(false);
    expect(result.straddles).toHaveLength(0);
    expect(result.adjustedBigBlind).toBe(10);
  });

  it('should not straddle if insufficient stack', () => {
    straddleEngine.toggleAutoStraddle('str-proc', 'p1', true);

    const result = straddleEngine.processStraddles(
      'str-proc',
      10,
      [{ seat: 3, playerId: 'p1' }],
      new Map([['p1', 15]]) // Less than 20 (2x BB)
    );

    expect(result.posted).toBe(false);
  });

  it('should emit STRADDLE_POSTED for each straddle', () => {
    straddleEngine.toggleAutoStraddle('str-proc', 'p1', true);

    straddleEngine.processStraddles(
      'str-proc',
      10,
      [{ seat: 3, playerId: 'p1' }],
      new Map([['p1', 1000]])
    );

    expect(masterBus.emit).toHaveBeenCalledWith(
      'STRADDLE_POSTED',
      expect.objectContaining({ tableId: 'str-proc', amount: 20 })
    );
  });

  it('should stop at non-enrolled player', () => {
    straddleEngine.toggleAutoStraddle('str-proc', 'p1', true);
    // p2 is NOT enrolled

    straddleEngine.configure('str-proc', {
      enabled: true,
      mississippiEnabled: true,
      maxStraddles: 3,
      straddleMultiplier: 2,
    });

    const result = straddleEngine.processStraddles(
      'str-proc',
      10,
      [
        { seat: 3, playerId: 'p1' },
        { seat: 4, playerId: 'p2' }, // Not enrolled — stops here
        { seat: 5, playerId: 'p3' },
      ],
      new Map([
        ['p1', 1000],
        ['p2', 1000],
        ['p3', 1000],
      ])
    );

    expect(result.straddles).toHaveLength(1);
  });
});

describe('StraddleEngine - Mississippi Straddle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    straddleEngine.configure('str-miss', {
      enabled: true,
      mississippiEnabled: true,
      maxStraddles: 3,
      straddleMultiplier: 2,
    });
  });

  afterEach(() => straddleEngine.dispose('str-miss'));

  it('should allow multiple straddles with Mississippi enabled', () => {
    straddleEngine.toggleAutoStraddle('str-miss', 'p1', true);
    straddleEngine.toggleAutoStraddle('str-miss', 'p2', true);
    straddleEngine.toggleAutoStraddle('str-miss', 'p3', true);

    const result = straddleEngine.processStraddles(
      'str-miss',
      10,
      [
        { seat: 3, playerId: 'p1' },
        { seat: 4, playerId: 'p2' },
        { seat: 5, playerId: 'p3' },
      ],
      new Map([
        ['p1', 5000],
        ['p2', 5000],
        ['p3', 5000],
      ])
    );

    expect(result.straddles).toHaveLength(3);
    expect(result.straddles[0].amount).toBe(20); // 10 * 2
    expect(result.straddles[1].amount).toBe(40); // 20 * 2
    expect(result.straddles[2].amount).toBe(80); // 40 * 2
    expect(result.adjustedBigBlind).toBe(80);
  });

  it('should not allow multiple without Mississippi enabled', () => {
    straddleEngine.configure('str-miss', {
      enabled: true,
      mississippiEnabled: false,
      maxStraddles: 3,
      straddleMultiplier: 2,
    });

    straddleEngine.toggleAutoStraddle('str-miss', 'p1', true);
    straddleEngine.toggleAutoStraddle('str-miss', 'p2', true);

    const result = straddleEngine.processStraddles(
      'str-miss',
      10,
      [
        { seat: 3, playerId: 'p1' },
        { seat: 4, playerId: 'p2' },
      ],
      new Map([
        ['p1', 5000],
        ['p2', 5000],
      ])
    );

    expect(result.straddles).toHaveLength(1); // Only UTG
  });
});

describe('StraddleEngine - Manual Straddle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    straddleEngine.configure('str-man', {
      enabled: true,
      mississippiEnabled: false,
      maxStraddles: 1,
      straddleMultiplier: 2,
    });
  });

  afterEach(() => straddleEngine.dispose('str-man'));

  it('should allow manual straddle post', () => {
    const post = straddleEngine.postManualStraddle('str-man', 'p1', 3, 10, 1000);
    expect(post).not.toBeNull();
    expect(post!.amount).toBe(20);
    expect(post!.isAutoStraddle).toBe(false);
  });

  it('should reject when insufficient stack', () => {
    const post = straddleEngine.postManualStraddle('str-man', 'p1', 3, 10, 15);
    expect(post).toBeNull();
  });

  it('should reject when max straddles reached', () => {
    straddleEngine.postManualStraddle('str-man', 'p1', 3, 10, 1000);
    const second = straddleEngine.postManualStraddle('str-man', 'p2', 4, 10, 1000);
    expect(second).toBeNull(); // maxStraddles: 1
  });
});

describe('StraddleEngine - Cleanup', () => {
  it('should dispose table state', () => {
    straddleEngine.configure('str-disp', {
      enabled: true,
      mississippiEnabled: false,
      maxStraddles: 1,
      straddleMultiplier: 2,
    });
    straddleEngine.dispose('str-disp');
    expect(straddleEngine.getState('str-disp')).toBeNull();
  });
});
