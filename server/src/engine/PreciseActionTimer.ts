import { reportError } from '../services/errorReporter.js';
import { deadlineScheduler, type DeadlineScheduler } from './DeadlineScheduler.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PRECISE ACTION TIMER — Server-Side Deadline Tracking
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Records per-player absolute turn deadlines and fires an onExpiry callback
 * when the deadline is reached. Extension, pause, and resume semantics are
 * preserved for existing callers (TimeBankEngine, insurance/RIT flows).
 *
 * Phase 1.2 PR-B: the internal polling interval is gone — a single
 * process-global DeadlineScheduler handles every timer across every table.
 * This class is now a thin stateful wrapper that registers/un-registers
 * schedule entries and keeps the Map of ActionDeadline for getRemainingMs,
 * pause state, and event dispatch.
 *
 * Why the indirection: DeadlineScheduler gives us
 *   - drift-free 100ms tick granularity across all tables
 *   - maxFirePerTick backpressure so a burst of expirations can't stall
 *     the event loop
 *   - persistPending/rehydrate for restart resilience (PR-D)
 *   - throw isolation between callbacks
 * Callers of PreciseActionTimer get those benefits with zero API change.
 */

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

export type TimerEventType =
  | 'TIMER_STARTED'
  | 'TIMER_EXPIRED'
  | 'TIMER_EXTENDED'
  | 'TIMER_PAUSED'
  | 'TIMER_RESUMED'
  | 'TIMER_CANCELLED';

export interface TimerEvent {
  type: TimerEventType;
  tableId: string;
  playerId: string;
  durationMs?: number;
  deadline?: number;
  additionalMs?: number;
  driftMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRECISE ACTION TIMER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class PreciseActionTimer {
  private deadlines: Map<string, ActionDeadline> = new Map();
  private onEvent?: (event: TimerEvent) => void;
  /**
   * The scheduler that does the actual ticking + expiry firing. Can be
   * overridden in tests. In production this is the singleton from
   * DeadlineScheduler.ts.
   */
  private scheduler: DeadlineScheduler;
  /**
   * Current-time function. Must use the same clock as the scheduler so
   * deadlines stored in the Map match the scheduler's ordering. Defaults
   * to Date.now; tests inject a mock clock shared with the scheduler.
   */
  private now: () => number;

  constructor(
    onEvent?: (event: TimerEvent) => void,
    scheduler: DeadlineScheduler = deadlineScheduler,
    now: () => number = Date.now
  ) {
    this.onEvent = onEvent;
    this.scheduler = scheduler;
    this.now = now;
    // Ensure the shared scheduler is running. start() is idempotent.
    this.scheduler.start();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — unchanged surface; internals delegate to DeadlineScheduler.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start a new action timer for a player.
   * Records the absolute deadline and registers it with the scheduler.
   */
  startTimer(tableId: string, playerId: string, durationMs: number, onExpiry?: () => void): void {
    const now = this.now();
    this.armTimer(tableId, playerId, now + durationMs, durationMs, now, onExpiry);
  }

  /** Preserve an existing absolute deadline across timer ownership handoffs. */
  startTimerAt(tableId: string, playerId: string, deadlineMs: number, onExpiry?: () => void): void {
    const now = this.now();
    this.armTimer(tableId, playerId, deadlineMs, Math.max(0, deadlineMs - now), now, onExpiry);
  }

  private armTimer(
    tableId: string,
    playerId: string,
    deadlineMs: number,
    durationMs: number,
    now: number,
    onExpiry?: () => void
  ): void {
    const key = this.key(tableId, playerId);

    // Cancel any existing timer for this player — idempotent re-schedule
    // is handled by DeadlineScheduler.schedule(), but we also need to clear
    // our own Map entry and emit the CANCELLED event for observers.
    if (this.deadlines.has(key)) {
      this.cancelTimer(tableId, playerId);
    }

    const deadline: ActionDeadline = {
      tableId,
      playerId,
      deadline: deadlineMs,
      durationMs,
      startedAt: now,
      isPaused: false,
      pausedRemainingMs: 0,
      onExpiry: onExpiry || null,
    };
    this.deadlines.set(key, deadline);

    this.scheduler.schedule({
      tableId,
      eventId: this.eventId(playerId),
      deadlineMs: deadline.deadline,
      callback: () => this.onExpired(tableId, playerId),
    });

    this.emitEvent({
      type: 'TIMER_STARTED',
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
    const remaining = dl.deadline - this.now();
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
    return this.now() >= dl.deadline;
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
      // Re-schedule with the new deadline. schedule() is idempotent on the
      // eventId so this replaces the prior entry without us having to cancel.
      this.scheduler.schedule({
        tableId,
        eventId: this.eventId(playerId),
        deadlineMs: dl.deadline,
        callback: () => this.onExpired(tableId, playerId),
      });
    }

    this.emitEvent({
      type: 'TIMER_EXTENDED',
      tableId,
      playerId,
      additionalMs,
      deadline: dl.isPaused ? 0 : dl.deadline,
    });
  }

  /**
   * Pause the timer (e.g., during insurance offer or RIT offer).
   */
  pauseTimer(tableId: string, playerId: string): void {
    const dl = this.deadlines.get(this.key(tableId, playerId));
    if (!dl || dl.isPaused) return;

    dl.isPaused = true;
    dl.pausedRemainingMs = Math.max(0, dl.deadline - this.now());
    // While paused, the scheduler shouldn't fire — pull the entry out.
    this.scheduler.cancel(tableId, this.eventId(playerId));

    this.emitEvent({ type: 'TIMER_PAUSED', tableId, playerId });
  }

  /**
   * Resume the timer after pause.
   */
  resumeTimer(tableId: string, playerId: string): void {
    const dl = this.deadlines.get(this.key(tableId, playerId));
    if (!dl || !dl.isPaused) return;

    dl.isPaused = false;
    dl.deadline = this.now() + dl.pausedRemainingMs;
    dl.pausedRemainingMs = 0;
    // Re-register with the scheduler at the new deadline.
    this.scheduler.schedule({
      tableId,
      eventId: this.eventId(playerId),
      deadlineMs: dl.deadline,
      callback: () => this.onExpired(tableId, playerId),
    });

    this.emitEvent({
      type: 'TIMER_RESUMED',
      tableId,
      playerId,
      deadline: dl.deadline,
    });
  }

  /**
   * Cancel a player's timer (player acted in time).
   */
  cancelTimer(tableId: string, playerId: string): void {
    const key = this.key(tableId, playerId);
    if (this.deadlines.has(key)) {
      this.deadlines.delete(key);
      this.scheduler.cancel(tableId, this.eventId(playerId));
      this.emitEvent({ type: 'TIMER_CANCELLED', tableId, playerId });
    }
  }

  /**
   * Cancel all of THIS TABLE'S turn timers.
   *
   * SWEEP #4 FIX (2026-07-23): this used to call `scheduler.cancelAll(tableId)`,
   * which removes EVERY entry for the table on the shared DeadlineScheduler —
   * including ServerTableEngine's `heartbeat_check` deadline, which re-arms only
   * from inside its own callback. Because clearTable() runs at every HAND_COMPLETE,
   * cancelAll() permanently killed the heartbeat after the first completed hand,
   * regressing mid-hand disconnect detection (FIX 147) to the pre-fix "only between
   * hands" behaviour. Cancel only the `turn:<playerId>` eventIds this class owns.
   */
  clearTable(tableId: string): void {
    const prefix = `${tableId}:`;
    for (const key of [...this.deadlines.keys()]) {
      if (key.startsWith(prefix)) {
        const playerId = key.slice(prefix.length);
        // FIX 2026-08-22: TimeBankEngine and DisconnectEngine register their
        // countdowns through this same API under NAMESPACED ids
        // ("timebank:<pid>", "disconnect:<pid>"). clearTable's contract (and
        // every doc comment at its call sites) says it clears only plain turn
        // timers — but it was cancelling the namespaced ones too, leaving
        // e.g. a time bank marked `isActive` with NO countdown behind it, so
        // rearmTurnTimerIfCurrent bailed and a reconnecting player got no
        // clock. Namespaced entries are owned by their engines (which handle
        // expiry fail-safe and clean up in disposeAll); leave them alone.
        if (playerId.includes(':')) continue;
        this.scheduler.cancel(tableId, this.eventId(playerId));
        this.deadlines.delete(key);
      }
    }
  }

  /**
   * Check if a timer exists (active or paused) for a player.
   */
  hasTimer(tableId: string, playerId: string): boolean {
    return this.deadlines.has(this.key(tableId, playerId));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Called by the scheduler when a deadline fires. */
  private onExpired(tableId: string, playerId: string): void {
    const key = this.key(tableId, playerId);
    const dl = this.deadlines.get(key);
    if (!dl) return; // Already cancelled between scheduling and tick.
    if (dl.isPaused) return; // Paused between schedule and tick — scheduler cancelled, but safety check.

    this.deadlines.delete(key);

    this.emitEvent({
      type: 'TIMER_EXPIRED',
      tableId,
      playerId,
      driftMs: this.now() - dl.deadline,
    });

    if (dl.onExpiry) {
      try {
        dl.onExpiry();
      } catch (err: unknown) {
        reportError(err, 'PreciseActionTimer.Expiry_callback_error_for_dlta');
      }
    }
  }

  private key(tableId: string, playerId: string): string {
    return `${tableId}:${playerId}`;
  }

  /** Scheduler eventId for this player's turn. Prefix isolates from other engines. */
  private eventId(playerId: string): string {
    return `turn:${playerId}`;
  }

  private emitEvent(event: TimerEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'PreciseActionTimer.Event_handler_error');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP — called when the engine for a table shuts down.
  // Kept for backward compat; now a cancel-all wrapper.
  // ═══════════════════════════════════════════════════════════════════════════

  dispose(): void {
    // Cancel every entry. We don't stop the shared scheduler because other
    // table engines may still be using it.
    for (const dl of this.deadlines.values()) {
      this.scheduler.cancel(dl.tableId, this.eventId(dl.playerId));
    }
    this.deadlines.clear();
  }
}
