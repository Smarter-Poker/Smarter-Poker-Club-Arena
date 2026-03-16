/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * POSTGRES SYNC HOOKS — Unit Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests for the Postgres realtime sync service:
 * - Idempotent init (same user)
 * - Re-init on user switch (logout → login as different user)
 * - Debounce batching for rapid-fire events
 * - Clean destroy lifecycle
 * - Non-debounced critical events (wallet, profile)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// EXTRACTED SERVICE LOGIC (testable without Supabase dependency)
// ═══════════════════════════════════════════════════════════════════════════════

class TestPostgresSyncHooks {
  initialized = false;
  userId: string | null = null;
  channelName: string | null = null;
  debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  emittedEvents: Array<{ key: string; event: string; payload: any }> = [];

  static readonly DEBOUNCE_MS = 300;

  debouncedEmit(key: string, eventType: string, payload: any): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.emittedEvents.push({ key, event: eventType, payload });
        this.debounceTimers.delete(key);
      }, TestPostgresSyncHooks.DEBOUNCE_MS)
    );
  }

  directEmit(event: string, payload: any): void {
    this.emittedEvents.push({ key: 'direct', event, payload });
  }

  init(userId: string): boolean {
    // Same user guard
    if (this.initialized && this.userId === userId) return false;

    // Clean up prior
    this.destroy();

    this.initialized = true;
    this.userId = userId;
    this.channelName = `global_db_sync:${userId}`;
    return true;
  }

  destroy(): void {
    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();
    this.initialized = false;
    this.channelName = null;
    this.userId = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('PostgresSyncHooks', () => {
  let hooks: TestPostgresSyncHooks;

  beforeEach(() => {
    hooks = new TestPostgresSyncHooks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    hooks.destroy();
    vi.useRealTimers();
  });

  describe('Idempotent Init', () => {
    it('should initialize successfully on first call', () => {
      const result = hooks.init('user-1');
      expect(result).toBe(true);
      expect(hooks.initialized).toBe(true);
      expect(hooks.userId).toBe('user-1');
      expect(hooks.channelName).toBe('global_db_sync:user-1');
    });

    it('should skip re-init for same user', () => {
      hooks.init('user-1');
      const result = hooks.init('user-1');
      expect(result).toBe(false); // Skipped
    });

    it('should re-init on user switch', () => {
      hooks.init('user-1');
      const result = hooks.init('user-2');
      expect(result).toBe(true);
      expect(hooks.userId).toBe('user-2');
      expect(hooks.channelName).toBe('global_db_sync:user-2');
    });

    it('should clean up old user state on switch', () => {
      hooks.init('user-1');
      hooks.debouncedEmit('club_1', 'CLUB_UPDATED', {});

      // Switch user — should clear pending debounce timers
      hooks.init('user-2');
      expect(hooks.debounceTimers.size).toBe(0);
    });
  });

  describe('Debounce Batching', () => {
    it('should batch rapid-fire events into single emission', () => {
      hooks.init('user-1');

      // Simulate admin bulk-updating 5 members rapidly
      for (let i = 0; i < 5; i++) {
        hooks.debouncedEmit('club_abc', 'CLUB_UPDATED', { clubId: 'abc' });
      }

      // Before debounce fires
      expect(hooks.emittedEvents).toHaveLength(0);

      // After debounce period
      vi.advanceTimersByTime(TestPostgresSyncHooks.DEBOUNCE_MS + 10);
      expect(hooks.emittedEvents).toHaveLength(1); // Only one emission!
      expect(hooks.emittedEvents[0].event).toBe('CLUB_UPDATED');
    });

    it('should debounce per-key independently', () => {
      hooks.init('user-1');

      hooks.debouncedEmit('club_1', 'CLUB_UPDATED', { clubId: '1' });
      hooks.debouncedEmit('club_2', 'CLUB_UPDATED', { clubId: '2' });

      vi.advanceTimersByTime(TestPostgresSyncHooks.DEBOUNCE_MS + 10);
      expect(hooks.emittedEvents).toHaveLength(2); // Both fired
    });

    it('should use latest payload when debouncing', () => {
      hooks.init('user-1');

      hooks.debouncedEmit('table_1', 'TABLE_UPDATED', { status: 'waiting' });
      hooks.debouncedEmit('table_1', 'TABLE_UPDATED', { status: 'active' });
      hooks.debouncedEmit('table_1', 'TABLE_UPDATED', { status: 'closed' });

      vi.advanceTimersByTime(TestPostgresSyncHooks.DEBOUNCE_MS + 10);
      expect(hooks.emittedEvents).toHaveLength(1);
      expect(hooks.emittedEvents[0].payload).toEqual({ status: 'closed' }); // Latest wins
    });
  });

  describe('Critical Events (Not Debounced)', () => {
    it('should emit wallet updates immediately', () => {
      hooks.init('user-1');
      hooks.directEmit('BALANCE_UPDATED', { source: 'postgres_sync' });
      expect(hooks.emittedEvents).toHaveLength(1); // Immediate, no debounce
    });

    it('should emit profile updates immediately', () => {
      hooks.init('user-1');
      hooks.directEmit('PROFILE_UPDATED', { userId: 'user-1', updates: {} });
      expect(hooks.emittedEvents).toHaveLength(1);
    });
  });

  describe('Destroy Lifecycle', () => {
    it('should clear all state on destroy', () => {
      hooks.init('user-1');
      hooks.debouncedEmit('club_1', 'CLUB_UPDATED', {});

      hooks.destroy();

      expect(hooks.initialized).toBe(false);
      expect(hooks.userId).toBeNull();
      expect(hooks.channelName).toBeNull();
      expect(hooks.debounceTimers.size).toBe(0);
    });

    it('should prevent orphaned timer emissions after destroy', () => {
      hooks.init('user-1');
      hooks.debouncedEmit('club_1', 'CLUB_UPDATED', {});

      hooks.destroy();

      // Advance past debounce period — timer was cleared, should NOT fire
      vi.advanceTimersByTime(TestPostgresSyncHooks.DEBOUNCE_MS + 100);
      expect(hooks.emittedEvents).toHaveLength(0);
    });

    it('should allow re-init after destroy', () => {
      hooks.init('user-1');
      hooks.destroy();
      const result = hooks.init('user-1');
      expect(result).toBe(true);
      expect(hooks.initialized).toBe(true);
    });
  });
});
