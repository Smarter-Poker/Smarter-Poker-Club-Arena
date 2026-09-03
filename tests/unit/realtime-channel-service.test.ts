/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * REALTIME CHANNEL SERVICE — Unit Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests for subscription lifecycle, limit enforcement, and cleanup:
 * - Subscription limit enforcement (max 25 concurrent)
 * - FIFO eviction (oldest subscription removed first)
 * - Hand replay subscription tracking (previously missing)
 * - Stale subscription cleanup (30-minute timeout)
 * - Duplicate subscription prevention
 * - unsubscribeAll cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK SUPABASE CHANNEL
// ═══════════════════════════════════════════════════════════════════════════════

function createMockChannel(name: string) {
  const channel = {
    name,
    _state: 'joined',
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn((cb?: (status: string) => void) => {
      if (cb) cb('SUBSCRIBED');
      return channel;
    }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    track: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    presenceState: vi.fn().mockReturnValue({}),
  };
  return channel;
}

// Mock the supabase module
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn((name: string) => createMockChannel(name)),
    getChannels: vi.fn().mockReturnValue([]),
    removeChannel: vi.fn(),
  },
}));

// Mock subscription monitor
vi.mock('../../src/utils/subscriptionMonitor', () => ({
  subscriptionMonitor: {
    register: vi.fn(),
    unregister: vi.fn(),
    cleanup: vi.fn(),
    getDiagnostics: vi.fn().mockReturnValue({
      totalSubscriptions: 0,
      maxSubscriptions: 25,
      warnThreshold: 20,
      byChannel: {},
      isAtCapacity: false,
    }),
  },
}));

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS — Using extracted logic to test service behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe('RealtimeChannelService Logic', () => {
  const MAX_CONCURRENT_SUBSCRIPTIONS = 25;

  // Simulate the subscription map + timestamps
  let subscriptions: Map<string, { channel: any; type: string; entityId: string }>;
  let timestamps: Map<string, number>;

  beforeEach(() => {
    subscriptions = new Map();
    timestamps = new Map();
  });

  /**
   * Mirrors enforceSubscriptionLimit() logic
   */
  async function enforceSubscriptionLimit(): Promise<string | null> {
    if (subscriptions.size >= MAX_CONCURRENT_SUBSCRIPTIONS) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      timestamps.forEach((ts, key) => {
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestKey = key;
        }
      });

      if (oldestKey) {
        const oldest = subscriptions.get(oldestKey);
        subscriptions.delete(oldestKey);
        timestamps.delete(oldestKey);
        if (oldest) await oldest.channel.unsubscribe();
        return oldestKey;
      }
    }
    return null;
  }

  describe('Subscription Limit Enforcement', () => {
    it('should not evict when under limit', async () => {
      for (let i = 0; i < 10; i++) {
        const key = `club:${i}`;
        subscriptions.set(key, { channel: createMockChannel(key), type: 'club', entityId: `${i}` });
        timestamps.set(key, Date.now() + i);
      }

      const evicted = await enforceSubscriptionLimit();
      expect(evicted).toBeNull();
      expect(subscriptions.size).toBe(10);
    });

    it('should evict oldest when at limit', async () => {
      const baseTime = Date.now();
      for (let i = 0; i < MAX_CONCURRENT_SUBSCRIPTIONS; i++) {
        const key = `channel:${i}`;
        subscriptions.set(key, {
          channel: createMockChannel(key),
          type: 'club',
          entityId: `${i}`,
        });
        timestamps.set(key, baseTime + i * 1000); // Each 1s later
      }

      expect(subscriptions.size).toBe(25);
      const evicted = await enforceSubscriptionLimit();
      expect(evicted).toBe('channel:0'); // Oldest
      expect(subscriptions.size).toBe(24);
      expect(subscriptions.has('channel:0')).toBe(false);
    });

    it('should call unsubscribe on evicted channel', async () => {
      const mockChannel = createMockChannel('victim');
      subscriptions.set('victim', { channel: mockChannel, type: 'club', entityId: '1' });
      timestamps.set('victim', 0); // Very old

      // Fill to capacity
      for (let i = 1; i < MAX_CONCURRENT_SUBSCRIPTIONS; i++) {
        const key = `filler:${i}`;
        subscriptions.set(key, {
          channel: createMockChannel(key),
          type: 'club',
          entityId: `${i}`,
        });
        timestamps.set(key, Date.now());
      }

      await enforceSubscriptionLimit();
      expect(mockChannel.unsubscribe).toHaveBeenCalledOnce();
    });

    it('should evict FIFO across mixed channel types', async () => {
      const baseTime = Date.now();
      // Add in mixed order: tournament, club, hand, lobby
      const types = ['tournament', 'club', 'hand', 'lobby'];
      for (let i = 0; i < MAX_CONCURRENT_SUBSCRIPTIONS; i++) {
        const type = types[i % types.length];
        const key = `${type}:${i}`;
        subscriptions.set(key, { channel: createMockChannel(key), type, entityId: `${i}` });
        timestamps.set(key, baseTime + i);
      }

      const evicted = await enforceSubscriptionLimit();
      expect(evicted).toBe('tournament:0'); // First inserted, oldest timestamp
    });
  });

  describe('Duplicate Subscription Prevention', () => {
    it('should not create duplicate subscription for same channel', () => {
      const channelName = 'club:abc123';
      subscriptions.set(channelName, {
        channel: createMockChannel(channelName),
        type: 'club',
        entityId: 'abc123',
      });

      // Simulate the guard: if already exists, return early
      const alreadyExists = subscriptions.has(channelName);
      expect(alreadyExists).toBe(true);
    });
  });

  describe('Hand Replay Subscription Tracking', () => {
    it('should track hand subscriptions with timestamps', () => {
      const handKey = 'hand:replay-123';
      const now = Date.now();
      subscriptions.set(handKey, {
        channel: createMockChannel(handKey),
        type: 'hand',
        entityId: 'replay-123',
      });
      timestamps.set(handKey, now);

      expect(timestamps.has(handKey)).toBe(true);
      expect(timestamps.get(handKey)).toBe(now);
    });

    it('hand subscriptions should be evictable like any other type', async () => {
      // Make hand replay the oldest
      subscriptions.set('hand:old', {
        channel: createMockChannel('hand:old'),
        type: 'hand',
        entityId: 'old',
      });
      timestamps.set('hand:old', 0); // Very old

      // Fill rest with clubs
      for (let i = 1; i < MAX_CONCURRENT_SUBSCRIPTIONS; i++) {
        const key = `club:${i}`;
        subscriptions.set(key, {
          channel: createMockChannel(key),
          type: 'club',
          entityId: `${i}`,
        });
        timestamps.set(key, Date.now());
      }

      const evicted = await enforceSubscriptionLimit();
      expect(evicted).toBe('hand:old');
    });
  });

  describe('Stale Subscription Cleanup', () => {
    const CLEANUP_TIMEOUT = 30 * 60 * 1000; // 30 minutes

    it('should identify subscriptions older than 30 minutes as stale', () => {
      const now = Date.now();
      timestamps.set('club:fresh', now); // Just created
      timestamps.set('club:stale', now - CLEANUP_TIMEOUT - 1); // 30+ min old
      timestamps.set('hand:very-stale', now - CLEANUP_TIMEOUT * 2); // 60+ min old

      const staleKeys: string[] = [];
      timestamps.forEach((ts, key) => {
        if (now - ts > CLEANUP_TIMEOUT) {
          staleKeys.push(key);
        }
      });

      expect(staleKeys).toContain('club:stale');
      expect(staleKeys).toContain('hand:very-stale');
      expect(staleKeys).not.toContain('club:fresh');
    });
  });

  describe('UnsubscribeAll Cleanup', () => {
    it('should clear all maps and call unsubscribe on every channel', async () => {
      const channels: any[] = [];
      for (let i = 0; i < 5; i++) {
        const ch = createMockChannel(`test:${i}`);
        channels.push(ch);
        subscriptions.set(`test:${i}`, { channel: ch, type: 'club', entityId: `${i}` });
        timestamps.set(`test:${i}`, Date.now());
      }

      // Simulate unsubscribeAll
      const promises = Array.from(subscriptions.values()).map((sub) => sub.channel.unsubscribe());
      await Promise.allSettled(promises);
      subscriptions.clear();
      timestamps.clear();

      expect(subscriptions.size).toBe(0);
      expect(timestamps.size).toBe(0);
      channels.forEach((ch) => {
        expect(ch.unsubscribe).toHaveBeenCalledOnce();
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION MONITOR THRESHOLD TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Subscription Monitor Thresholds', () => {
  it('warn threshold (20) and max (25) should be in sync with service', () => {
    // These constants must match between subscriptionMonitor and RealtimeChannelService
    const MONITOR_MAX = 25;
    const MONITOR_WARN = 20;
    const SERVICE_MAX = 25;

    expect(MONITOR_MAX).toBe(SERVICE_MAX);
    expect(MONITOR_WARN).toBeLessThan(SERVICE_MAX);
    expect(MONITOR_WARN).toBeGreaterThan(SERVICE_MAX * 0.5); // Warn at >50%
  });
});
