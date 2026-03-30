/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PRECISE ACTION TIMER — Server-Side Deadline Tracking
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Replaces unreliable setTimeout-based timers with deadline-based timers:
 * - Records an absolute deadline (Date.now() + duration)
 * - All expiry checks compare against the real clock, not timer callbacks
 * - Immune to timer drift under high CPU load
 * - 100ms precision polling for expiry callbacks
 * - Integrates with TimeBankEngine for extension
 */

import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ActionDeadline {
  tableId: string;
  playerId: string;
  deadline: number; // Absolute ms timestamp
  durationMs: number; // Original duration
  startedAt: number; // When timer was started
  isPaused: boolean;
  pausedRemainingMs: number;
  onExpiry: (() => void) | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRECISE ACTION TIMER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class PreciseActionTimerClass {
  private deadlines: Map<string, ActionDeadline> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollMs: number = 100; // 100ms precision

  constructor() {
    this.startPolling();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start a new action timer for a player.
   * Records the absolute deadline and sets up expiry callback.
   */
  startTimer(tableId: string, playerId: string, durationMs: number, onExpiry?: () => void): void {
    const key = this.key(tableId, playerId);
    const now = Date.now();

    // Cancel any existing timer for this player
    this.cancelTimer(tableId, playerId);

    const deadline: ActionDeadline = {
      tableId,
      playerId,
      deadline: now + durationMs,
      durationMs,
      startedAt: now,
      isPaused: false,
      pausedRemainingMs: 0,
      onExpiry: onExpiry || null,
    };

    this.deadlines.set(key, deadline);

    masterBus.emit('ACTION_TIMER_STARTED', {
      tableId,
      playerId,
      durationMs,
      deadline: deadline.deadline,
    });
  }

  /**
   * Get remaining time in milliseconds.
   * Uses real clock comparison, not timer state.
   */
  getRemainingMs(tableId: string, playerId: string): number {
    const dl = this.deadlines.get(this.key(tableId, playerId));
    if (!dl) return 0;

    if (dl.isPaused) return dl.pausedRemainingMs;

    const remaining = dl.deadline - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * Get remaining time in seconds (rounded up).
   */
  getRemainingSec(tableId: string, playerId: string): number {
    return Math.ceil(this.getRemainingMs(tableId, playerId) / 1000);
  }

  /**
   * Check if timer has expired.
   * Uses server-side deadline, immune to timer drift.
   */
  isExpired(tableId: string, playerId: string): boolean {
    const dl = this.deadlines.get(this.key(tableId, playerId));
    if (!dl) return true; // No timer = expired
    if (dl.isPaused) return false;
    return Date.now() >= dl.deadline;
  }

  /**
   * Get the absolute deadline timestamp.
   */
  getDeadline(tableId: string, playerId: string): number {
    return this.deadlines.get(this.key(tableId, playerId))?.deadline ?? 0;
  }

  /**
   * Extend the timer (e.g., when time bank activates).
   */
  extendTimer(tableId: string, playerId: string, additionalMs: number): void {
    const dl = this.deadlines.get(this.key(tableId, playerId));
    if (!dl) return;

    if (dl.isPaused) {
      dl.pausedRemainingMs += additionalMs;
    } else {
      dl.deadline += additionalMs;
    }

    masterBus.emit('ACTION_TIMER_EXTENDED', {
      tableId,
      playerId,
      additionalMs,
      newDeadline: dl.isPaused ? 0 : dl.deadline,
    });
  }

  /**
   * Pause the timer (e.g., during insurance offer).
   */
  pauseTimer(tableId: string, playerId: string): void {
    const dl = this.deadlines.get(this.key(tableId, playerId));
    if (!dl || dl.isPaused) return;

    dl.isPaused = true;
    dl.pausedRemainingMs = Math.max(0, dl.deadline - Date.now());
  }

  /**
   * Resume the timer after pause.
   */
  resumeTimer(tableId: string, playerId: string): void {
    const dl = this.deadlines.get(this.key(tableId, playerId));
    if (!dl || !dl.isPaused) return;

    dl.isPaused = false;
    dl.deadline = Date.now() + dl.pausedRemainingMs;
    dl.pausedRemainingMs = 0;
  }

  /**
   * Cancel a player's timer (player acted in time).
   */
  cancelTimer(tableId: string, playerId: string): void {
    this.deadlines.delete(this.key(tableId, playerId));
  }

  /**
   * Cancel all timers for a table.
   */
  clearTable(tableId: string): void {
    for (const key of [...this.deadlines.keys()]) {
      if (key.startsWith(`${tableId}:`)) {
        this.deadlines.delete(key);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: POLLING
  // ═══════════════════════════════════════════════════════════════════════════

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(() => {
      const now = Date.now();

      for (const [key, dl] of this.deadlines) {
        if (dl.isPaused) continue;
        if (now >= dl.deadline) {
          // Timer expired — fire callback and remove
          this.deadlines.delete(key);

          masterBus.emit('ACTION_TIMER_EXPIRED', {
            tableId: dl.tableId,
            playerId: dl.playerId,
            driftMs: now - dl.deadline, // How late the callback fired
          });

          if (dl.onExpiry) {
            try {
              dl.onExpiry();
            } catch (err: unknown) {
              reportError(err, 'PreciseActionTimer.Expiry_callback_error');
            }
          }
        }
      }
    }, this.pollMs);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  private key(tableId: string, playerId: string): string {
    return `${tableId}:${playerId}`;
  }

  dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.deadlines.clear();
  }
}

export const preciseActionTimer = new PreciseActionTimerClass();
export default preciseActionTimer;
