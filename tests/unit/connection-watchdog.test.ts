/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CONNECTION WATCHDOG — Unit Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests for the Supabase connection watchdog:
 * - Consecutive failure counting before declaring disconnect
 * - Reconnection behavior after recovery
 * - Timer lifecycle (start/stop/cleanup)
 * - handleOnline timer leak prevention
 * - Aggressive retry with escalating intervals
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// WATCHDOG LOGIC (extracted for testability)
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_CONSECUTIVE_FAILURES = 5;
const FAST_RETRY_INTERVALS = [5_000, 10_000, 20_000];
const HEARTBEAT_INTERVAL = 30_000;

class TestWatchdog {
  consecutiveFailures = 0;
  isConnected = true;
  started = false;
  events: string[] = [];

  // Track timers for leak detection
  private timers: Set<ReturnType<typeof setTimeout>> = new Set();

  start() {
    if (this.started) return;
    this.started = true;
    this.events.push('started');
  }

  stop() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.started = false;
    this.events.push('stopped');
  }

  markFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.markDisconnected();
    }
  }

  markConnected() {
    const wasDisconnected = !this.isConnected;
    this.isConnected = true;
    this.consecutiveFailures = 0;
    if (wasDisconnected) {
      this.events.push('connection_restored');
    }
  }

  private markDisconnected() {
    if (this.isConnected) {
      this.isConnected = false;
      this.events.push('disconnected');
    }
  }

  getRetryDelay(): number {
    const retryIndex = Math.min(this.consecutiveFailures - 1, FAST_RETRY_INTERVALS.length - 1);
    if (retryIndex < 0) return HEARTBEAT_INTERVAL;
    return FAST_RETRY_INTERVALS[retryIndex] || HEARTBEAT_INTERVAL;
  }

  scheduleTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(callback, delay);
    this.timers.add(timer);
    return timer;
  }

  get activeTimerCount(): number {
    return this.timers.size;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('SupabaseConnectionWatchdog', () => {
  let watchdog: TestWatchdog;

  beforeEach(() => {
    watchdog = new TestWatchdog();
    watchdog.start();
  });

  afterEach(() => {
    watchdog.stop();
  });

  describe('Failure Counting', () => {
    it('should not disconnect on first failure', () => {
      watchdog.markFailure();
      expect(watchdog.isConnected).toBe(true);
      expect(watchdog.consecutiveFailures).toBe(1);
    });

    it('should not disconnect on 4 consecutive failures', () => {
      for (let i = 0; i < 4; i++) {
        watchdog.markFailure();
      }
      expect(watchdog.isConnected).toBe(true);
      expect(watchdog.consecutiveFailures).toBe(4);
    });

    it('should disconnect after 5 consecutive failures', () => {
      for (let i = 0; i < 5; i++) {
        watchdog.markFailure();
      }
      expect(watchdog.isConnected).toBe(false);
      expect(watchdog.events).toContain('disconnected');
    });

    it('should only emit disconnected once for continued failures', () => {
      for (let i = 0; i < 10; i++) {
        watchdog.markFailure();
      }
      const disconnectEvents = watchdog.events.filter((e) => e === 'disconnected');
      expect(disconnectEvents).toHaveLength(1);
    });

    it('should reset counter on successful connection', () => {
      watchdog.markFailure();
      watchdog.markFailure();
      watchdog.markFailure();
      expect(watchdog.consecutiveFailures).toBe(3);

      watchdog.markConnected();
      expect(watchdog.consecutiveFailures).toBe(0);
      expect(watchdog.isConnected).toBe(true);
    });
  });

  describe('Recovery', () => {
    it('should emit connection_restored when recovering from disconnect', () => {
      // Drive to disconnect
      for (let i = 0; i < 5; i++) {
        watchdog.markFailure();
      }
      expect(watchdog.isConnected).toBe(false);

      // Recover
      watchdog.markConnected();
      expect(watchdog.isConnected).toBe(true);
      expect(watchdog.events).toContain('connection_restored');
    });

    it('should NOT emit connection_restored if was never disconnected', () => {
      watchdog.markFailure();
      watchdog.markConnected(); // Only 1 failure, never went to disconnected
      expect(watchdog.events).not.toContain('connection_restored');
    });
  });

  describe('Retry Intervals', () => {
    it('should use 5s delay after first failure', () => {
      watchdog.markFailure();
      expect(watchdog.getRetryDelay()).toBe(5_000);
    });

    it('should use 10s delay after second failure', () => {
      watchdog.markFailure();
      watchdog.markFailure();
      expect(watchdog.getRetryDelay()).toBe(10_000);
    });

    it('should use 20s delay after third failure', () => {
      for (let i = 0; i < 3; i++) watchdog.markFailure();
      expect(watchdog.getRetryDelay()).toBe(20_000);
    });

    it('should cap at 20s for subsequent failures', () => {
      for (let i = 0; i < 10; i++) watchdog.markFailure();
      expect(watchdog.getRetryDelay()).toBe(20_000);
    });

    it('should use heartbeat interval when no failures', () => {
      expect(watchdog.getRetryDelay()).toBe(HEARTBEAT_INTERVAL);
    });
  });

  describe('Timer Lifecycle', () => {
    it('should start only once (idempotent)', () => {
      watchdog.start();
      watchdog.start();
      const startEvents = watchdog.events.filter((e) => e === 'started');
      expect(startEvents).toHaveLength(1); // Only first start counted
    });

    it('should clear all timers on stop', () => {
      watchdog.scheduleTimer(() => {}, 100000);
      watchdog.scheduleTimer(() => {}, 200000);
      expect(watchdog.activeTimerCount).toBe(2);

      watchdog.stop();
      expect(watchdog.activeTimerCount).toBe(0);
      expect(watchdog.started).toBe(false);
    });

    it('handleOnline timer should be clearable (leak prevention)', () => {
      // Simulate handleOnline scheduling a delayed health check
      const timer = watchdog.scheduleTimer(() => {
        // This would be checkHealth() in production
      }, 500);

      expect(watchdog.activeTimerCount).toBe(1);

      // Simulate stop() being called before timer fires
      watchdog.stop();
      expect(watchdog.activeTimerCount).toBe(0);
    });
  });
});
