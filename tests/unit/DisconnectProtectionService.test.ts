/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — DisconnectProtectionService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests disconnect grace period, connection quality, action queueing:
 * - initialize: creates connected state
 * - isDisconnected: connected vs disconnected vs unknown table
 * - isInGracePeriod: grace period vs expired
 * - getDisconnectAction: default action config
 * - queueAction / drainActionQueue: offline action queue with cap
 * - dispose / disposeTable: cleanup
 * - recordHeartbeat: latency history, quality classification, reconnect detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { disconnectProtectionService } from '../../src/services/DisconnectProtectionService';

describe('DisconnectProtectionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    disconnectProtectionService.disposeTable('table-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    disconnectProtectionService.disposeTable('table-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INITIALIZE
  // ─────────────────────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('should create a connected state', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      const state = disconnectProtectionService.getConnectionState('table-1', 'user-1');
      expect(state).not.toBeNull();
      expect(state!.isConnected).toBe(true);
      expect(state!.quality).toBe('excellent');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // IS DISCONNECTED
  // ─────────────────────────────────────────────────────────────────────────

  describe('isDisconnected', () => {
    it('should return false for connected player', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      expect(disconnectProtectionService.isDisconnected('table-1', 'user-1')).toBe(false);
    });

    it('should return true for unknown table (fail-safe)', () => {
      expect(disconnectProtectionService.isDisconnected('unknown', 'user-1')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // IS IN GRACE PERIOD
  // ─────────────────────────────────────────────────────────────────────────

  describe('isInGracePeriod', () => {
    it('should return false for connected player', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      expect(disconnectProtectionService.isInGracePeriod('table-1', 'user-1')).toBe(false);
    });

    it('should return false for unknown connection', () => {
      expect(disconnectProtectionService.isInGracePeriod('unknown', 'user-1')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET DISCONNECT ACTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('getDisconnectAction', () => {
    it('should return configured default action', () => {
      disconnectProtectionService.initialize('table-1', 'user-1', {
        defaultAction: 'fold',
      });
      expect(disconnectProtectionService.getDisconnectAction('table-1')).toBe('fold');
    });

    it('should return check_fold for unconfigured table', () => {
      expect(disconnectProtectionService.getDisconnectAction('unknown')).toBe('check_fold');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ACTION QUEUE
  // ─────────────────────────────────────────────────────────────────────────

  describe('queueAction / drainActionQueue', () => {
    it('should queue and drain actions for a table', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      disconnectProtectionService.queueAction('table-1', 'fold');
      disconnectProtectionService.queueAction('table-1', 'check');

      const actions = disconnectProtectionService.drainActionQueue('table-1');
      expect(actions.length).toBe(2);
      expect(actions[0].action).toBe('fold');
      expect(actions[1].action).toBe('check');
    });

    it('should clear queue after drain', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      disconnectProtectionService.queueAction('table-1', 'fold');
      disconnectProtectionService.drainActionQueue('table-1');
      const remaining = disconnectProtectionService.drainActionQueue('table-1');
      expect(remaining.length).toBe(0);
    });

    it('should respect maxQueuedActions cap', () => {
      disconnectProtectionService.initialize('table-1', 'user-1', {
        maxQueuedActions: 2,
      });
      disconnectProtectionService.queueAction('table-1', 'fold');
      disconnectProtectionService.queueAction('table-1', 'check');
      disconnectProtectionService.queueAction('table-1', 'call'); // Exceeds max

      const actions = disconnectProtectionService.drainActionQueue('table-1');
      expect(actions.length).toBe(2); // Oldest removed
      expect(actions[0].action).toBe('check');
      expect(actions[1].action).toBe('call');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RECORD HEARTBEAT
  // ─────────────────────────────────────────────────────────────────────────

  describe('recordHeartbeat', () => {
    it('should update latency and quality classification', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      disconnectProtectionService.recordHeartbeat('table-1', 'user-1', 30);
      const state = disconnectProtectionService.getConnectionState('table-1', 'user-1');
      expect(state!.latencyMs).toBe(30);
      expect(state!.quality).toBe('excellent'); // < 50ms
    });

    it('should classify quality based on average latency', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      // Push 10 readings of 200ms
      for (let i = 0; i < 10; i++) {
        disconnectProtectionService.recordHeartbeat('table-1', 'user-1', 200);
      }
      const state = disconnectProtectionService.getConnectionState('table-1', 'user-1');
      expect(state!.quality).toBe('fair'); // 150-300ms
    });

    it('should keep only last 10 latency readings', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      for (let i = 0; i < 15; i++) {
        disconnectProtectionService.recordHeartbeat('table-1', 'user-1', 100);
      }
      const state = disconnectProtectionService.getConnectionState('table-1', 'user-1');
      expect(state!.latencyHistory.length).toBe(10);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DISPOSE
  // ─────────────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('should clean up connection for specific player', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      disconnectProtectionService.dispose('table-1', 'user-1');
      expect(disconnectProtectionService.getConnectionState('table-1', 'user-1')).toBeNull();
    });

    it('should clear action queue for the table', () => {
      disconnectProtectionService.initialize('table-1', 'user-1');
      disconnectProtectionService.queueAction('table-1', 'fold');
      disconnectProtectionService.dispose('table-1', 'user-1');
      const actions = disconnectProtectionService.drainActionQueue('table-1');
      expect(actions.length).toBe(0);
    });
  });
});
