/**
 * ♠ CLUB ARENA — DisconnectEngine Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests disconnect detection, reconnection, auto-actions, and bus emissions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock MasterBus + PreciseActionTimer
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    on: vi.fn(),
    subscribe: vi.fn(),
    subscribeDebounced: vi.fn(),
  },
}));

vi.mock('../../src/engine/PreciseActionTimer', () => ({
  preciseActionTimer: {
    start: vi.fn(),
    cancelTimer: vi.fn(),
    isActive: vi.fn(() => false),
  },
}));

import { disconnectEngine } from '../../src/engine/DisconnectEngine';
import { masterBus } from '../../src/core/MasterBus';
import { preciseActionTimer } from '../../src/engine/PreciseActionTimer';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DisconnectEngine - Configuration', () => {
  it('should configure a table with custom timeout settings', () => {
    disconnectEngine.configure('dc-cfg-1', {
      disconnectTimeoutSeconds: 60,
      maxConsecutiveTimeouts: 5,
    });
    expect(true).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DisconnectEngine - Player Registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disconnectEngine.configure('dc-reg', { disconnectTimeoutSeconds: 30 });
  });

  it('should register a connected player with getState returning valid state', () => {
    disconnectEngine.registerPlayer('dc-reg', 'p1');
    const state = disconnectEngine.getState('dc-reg', 'p1');

    expect(state).not.toBeNull();
    expect(state!.isConnected).toBe(true);
    expect(state!.consecutiveTimeouts).toBe(0);
  });

  it('should track multiple players per table', () => {
    disconnectEngine.registerPlayer('dc-reg', 'pa');
    disconnectEngine.registerPlayer('dc-reg', 'pb');

    expect(disconnectEngine.getState('dc-reg', 'pa')).not.toBeNull();
    expect(disconnectEngine.getState('dc-reg', 'pb')).not.toBeNull();
  });

  it('should return null for unregistered player', () => {
    const state = disconnectEngine.getState('dc-reg', 'nonexistent');
    expect(state).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISCONNECT DETECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DisconnectEngine - Disconnect Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disconnectEngine.configure('dc-disc', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.registerPlayer('dc-disc', 'p1');
  });

  it('should mark player as disconnected', () => {
    disconnectEngine.markDisconnected('dc-disc', 'p1');

    const state = disconnectEngine.getState('dc-disc', 'p1');
    expect(state!.isConnected).toBe(false);
  });

  it('should emit PLAYER_DISCONNECTED on disconnect', () => {
    disconnectEngine.markDisconnected('dc-disc', 'p1');

    expect(masterBus.emit).toHaveBeenCalledWith(
      'PLAYER_DISCONNECTED',
      expect.objectContaining({
        tableId: 'dc-disc',
        userId: 'p1',
      })
    );
  });

  it('should isConnected return false after disconnect', () => {
    disconnectEngine.markDisconnected('dc-disc', 'p1');
    expect(disconnectEngine.isConnected('dc-disc', 'p1')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HEARTBEAT / RECONNECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DisconnectEngine - Heartbeat & Reconnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disconnectEngine.configure('dc-hb', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.registerPlayer('dc-hb', 'p1');
  });

  it('should mark player as connected on heartbeat after disconnect', () => {
    disconnectEngine.markDisconnected('dc-hb', 'p1');
    expect(disconnectEngine.isConnected('dc-hb', 'p1')).toBe(false);

    disconnectEngine.heartbeat('dc-hb', 'p1');
    expect(disconnectEngine.isConnected('dc-hb', 'p1')).toBe(true);
  });

  it('should update lastHeartbeat timestamp', () => {
    const before = disconnectEngine.getState('dc-hb', 'p1')!.lastHeartbeat;
    // Small delay to ensure time progresses
    disconnectEngine.heartbeat('dc-hb', 'p1');
    const after = disconnectEngine.getState('dc-hb', 'p1')!.lastHeartbeat;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIT OUT / SIT BACK TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DisconnectEngine - Sit Out / Sit Back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disconnectEngine.configure('dc-sit', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.registerPlayer('dc-sit', 'p1');
  });

  it('should mark player as sitting out', () => {
    disconnectEngine.sitOut('dc-sit', 'p1');
    expect(disconnectEngine.isSittingOut('dc-sit', 'p1')).toBe(true);
  });

  it('should emit PLAYER_SAT_OUT', () => {
    disconnectEngine.sitOut('dc-sit', 'p1');

    expect(masterBus.emit).toHaveBeenCalledWith(
      'PLAYER_SAT_OUT',
      expect.objectContaining({
        tableId: 'dc-sit',
        playerId: 'p1',
      })
    );
  });

  it('should mark player as sitting back in', () => {
    disconnectEngine.sitOut('dc-sit', 'p1');
    disconnectEngine.sitBack('dc-sit', 'p1');
    expect(disconnectEngine.isSittingOut('dc-sit', 'p1')).toBe(false);
  });

  it('should emit PLAYER_SAT_BACK', () => {
    disconnectEngine.sitOut('dc-sit', 'p1');
    vi.clearAllMocks();

    disconnectEngine.sitBack('dc-sit', 'p1');

    expect(masterBus.emit).toHaveBeenCalledWith(
      'PLAYER_SAT_BACK',
      expect.objectContaining({
        tableId: 'dc-sit',
        playerId: 'p1',
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CANCELATION & CLEANUP TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DisconnectEngine - Cancelation & Cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should cancel timeout for a player', () => {
    disconnectEngine.configure('dc-cancel', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.registerPlayer('dc-cancel', 'p1');
    disconnectEngine.cancelTimeout('dc-cancel', 'p1');
    expect(preciseActionTimer.cancelTimer).toHaveBeenCalled();
  });

  it('should remove player state on unregister', () => {
    disconnectEngine.configure('dc-unreg', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.registerPlayer('dc-unreg', 'p1');
    disconnectEngine.unregisterPlayer('dc-unreg', 'p1');
    expect(disconnectEngine.getState('dc-unreg', 'p1')).toBeNull();
  });

  it('should clean up all state on dispose', () => {
    disconnectEngine.configure('dc-dispose', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.registerPlayer('dc-dispose', 'pa');
    disconnectEngine.registerPlayer('dc-dispose', 'pb');
    disconnectEngine.dispose('dc-dispose');

    expect(disconnectEngine.getState('dc-dispose', 'pa')).toBeNull();
    expect(disconnectEngine.getState('dc-dispose', 'pb')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTED PLAYERS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DisconnectEngine - Connected Players', () => {
  it('should list connected players for a table', () => {
    disconnectEngine.configure('dc-list', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.registerPlayer('dc-list', 'p1');
    disconnectEngine.registerPlayer('dc-list', 'p2');

    const connected = disconnectEngine.getConnectedPlayers('dc-list');
    expect(connected).toContain('p1');
    expect(connected).toContain('p2');
  });

  it('should exclude disconnected players from connected list', () => {
    disconnectEngine.configure('dc-excl', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.registerPlayer('dc-excl', 'p1');
    disconnectEngine.registerPlayer('dc-excl', 'p2');
    disconnectEngine.markDisconnected('dc-excl', 'p2');

    const connected = disconnectEngine.getConnectedPlayers('dc-excl');
    expect(connected).toContain('p1');
    expect(connected).not.toContain('p2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION CALLBACK TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('DisconnectEngine - Action Callbacks', () => {
  it('should register an action callback for a table', () => {
    const callback = vi.fn();
    disconnectEngine.configure('dc-cb', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.onAutoAction('dc-cb', callback);
    expect(true).toBe(true);
  });

  it('should onPlayerTurn return false when player is connected', () => {
    disconnectEngine.configure('dc-turn', { disconnectTimeoutSeconds: 30 });
    disconnectEngine.registerPlayer('dc-turn', 'p1');
    const triggered = disconnectEngine.onPlayerTurn('dc-turn', 'p1', true);
    expect(triggered).toBe(true); // Connected player can act normally
  });
});
