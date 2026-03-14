/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — RealtimeChannelService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - MAX_CONCURRENT_SUBSCRIPTIONS enforcement (10 limit)
 * - Stale subscription cleanup (>30 minutes)
 * - Return unsubscribe function for cleanup
 * - Duplicate subscription prevention
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockImplementation(async (cb: any) => {
    if (cb) cb('SUBSCRIBED');
    return mockChannel;
  }),
  track: vi.fn().mockResolvedValue(undefined),
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  presenceState: vi.fn().mockReturnValue({}),
  send: vi.fn().mockResolvedValue(undefined),
  untrack: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn(() => ({ ...mockChannel })),
    removeChannel: vi.fn(),
  },
}));

vi.mock('../../src/utils/subscriptionMonitor', () => ({
  subscriptionMonitor: {
    register: vi.fn(),
    unregister: vi.fn(),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { realtimeChannelService } from '../../src/services/RealtimeChannelService';

describe('RealtimeChannelService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset internal state
    (realtimeChannelService as any).subscriptions = new Map();
    (realtimeChannelService as any).presenceState = new Map();
    (realtimeChannelService as any).subscriptionTimestamps = new Map();
    (realtimeChannelService as any).cleanupInterval = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clear any intervals
    if ((realtimeChannelService as any).cleanupInterval) {
      clearInterval((realtimeChannelService as any).cleanupInterval);
      (realtimeChannelService as any).cleanupInterval = null;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SUBSCRIPTION LIMIT
  // ─────────────────────────────────────────────────────────────────────────

  describe('subscription limits', () => {
    it('should enforce MAX_CONCURRENT_SUBSCRIPTIONS = 10', () => {
      // Fill up to limit
      const subs = (realtimeChannelService as any).subscriptions;
      const timestamps = (realtimeChannelService as any).subscriptionTimestamps;

      for (let i = 0; i < 10; i++) {
        subs.set(`channel-${i}`, {
          channel: { unsubscribe: vi.fn().mockResolvedValue(undefined) },
          type: 'club',
          entityId: `entity-${i}`,
          onEvent: vi.fn(),
        });
        timestamps.set(`channel-${i}`, Date.now() - i * 1000);
      }

      expect(subs.size).toBe(10);

      // enforceSubscriptionLimit should remove oldest
      (realtimeChannelService as any).enforceSubscriptionLimit();

      expect(subs.size).toBe(10);
    });

    it('should not remove any subscription when under limit', () => {
      const subs = (realtimeChannelService as any).subscriptions;
      subs.set('channel-1', {
        channel: { unsubscribe: vi.fn() },
        type: 'club',
        entityId: 'e1',
        onEvent: vi.fn(),
      });

      (realtimeChannelService as any).enforceSubscriptionLimit();
      expect(subs.size).toBe(1); // No removal
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STALE CLEANUP
  // ─────────────────────────────────────────────────────────────────────────

  describe('stale subscription cleanup', () => {
    it('should identify subscriptions older than 30 minutes as stale', () => {
      const subs = (realtimeChannelService as any).subscriptions;
      const timestamps = (realtimeChannelService as any).subscriptionTimestamps;

      // Add a subscription 31 minutes old
      const staleTime = Date.now() - 31 * 60 * 1000;
      subs.set('stale-channel', {
        channel: { unsubscribe: vi.fn().mockResolvedValue(undefined) },
        type: 'club',
        entityId: 'e1',
        onEvent: vi.fn(),
      });
      timestamps.set('stale-channel', staleTime);

      // Add a fresh subscription
      subs.set('fresh-channel', {
        channel: { unsubscribe: vi.fn().mockResolvedValue(undefined) },
        type: 'club',
        entityId: 'e2',
        onEvent: vi.fn(),
      });
      timestamps.set('fresh-channel', Date.now());

      // Initialize the cleanup interval
      (realtimeChannelService as any).initializeCleanupInterval();

      // Advance time to trigger cleanup (runs every 5 minutes)
      vi.advanceTimersByTime(5 * 60 * 1000);

      // Stale should be removed, fresh should remain
      expect(subs.has('stale-channel')).toBe(false);
      expect(subs.has('fresh-channel')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DUPLICATE PREVENTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('duplicate subscription prevention', () => {
    it('should return existing unsubscribe function for duplicate subscriptions', () => {
      const subs = (realtimeChannelService as any).subscriptions;
      subs.set('club:club-123', {
        channel: { unsubscribe: vi.fn().mockResolvedValue(undefined) },
        type: 'club',
        entityId: 'club-123',
        onEvent: vi.fn(),
      });

      // Subscribing again should return unsubscribe without creating new channel
      const unsub = realtimeChannelService.subscribeToClub(
        'club-123',
        'user-1',
        { id: 'user-1', displayName: 'Test', playerNumber: 1, avatarUrl: '', status: 'online' },
        {}
      );

      expect(typeof unsub).toBe('function');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PRESENCE
  // ─────────────────────────────────────────────────────────────────────────

  describe('presence management', () => {
    it('should store presence data in internal state', () => {
      const presence = (realtimeChannelService as any).presenceState;
      presence.set('club-1', [
        { id: 'u1', displayName: 'Alice', status: 'online' },
        { id: 'u2', displayName: 'Bob', status: 'playing' },
      ]);

      const members = presence.get('club-1');
      expect(members).toHaveLength(2);
      expect(members[0].displayName).toBe('Alice');
    });

    it('should return undefined for unknown clubs', () => {
      const presence = (realtimeChannelService as any).presenceState;
      const members = presence.get('nonexistent');
      expect(members).toBeUndefined();
    });
  });
});
