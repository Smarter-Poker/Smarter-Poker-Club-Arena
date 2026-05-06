/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DeadlineScheduler — absolute-time, tick-based scheduler for engine events
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Replaces scattered setTimeout usage across ServerTableEngine, HandController,
 * TimeBankEngine, and DisconnectEngine with a single priority-queue-backed
 * scheduler that:
 *
 *   1. Stores absolute wall-clock deadlines (Date.now()+duration), not relative
 *      delays. Rehydrating after a server restart is trivial — compare against
 *      Date.now() and fire whatever should have already fired.
 *
 *   2. Runs a single setInterval at 100ms tick granularity per process. A busy
 *      event loop that would have delayed 50 setTimeouts non-uniformly still
 *      fires them all within one tick of their deadline.
 *
 *   3. Is idempotent: scheduling (tableId, eventId) twice replaces the prior
 *      entry. Cancelling a non-existent entry is a no-op.
 *
 *   4. Can persistPending() → JSON for a tableId so ServerTableEngine can
 *      snapshot it, and rehydrate(tableId, entries) on engine start to
 *      reinstall pending deadlines with drift correction.
 *
 * Not a drop-in replacement for PreciseActionTimer — that class wraps
 * reset/cancel semantics around setTimeout. DeadlineScheduler is a lower-
 * level primitive; PreciseActionTimer (and TimeBankEngine) will be rewritten
 * in PR-B to use it as the execution backend.
 *
 * Phase 1.2 PR-A, see spec
 * `.memory/specs/phase-1.2-deadline-timer-disconnect-grace.md`.
 */

import { reportError } from '../services/errorReporter.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Deadline {
  /** The table this deadline belongs to. Used for bulk cancel on engine shutdown. */
  tableId: string;
  /**
   * Event id unique within the table. Examples: "turn", "timebank_grant",
   * "disconnect_grace:<userId>". Re-scheduling the same (tableId, eventId)
   * replaces the earlier entry — idempotent.
   */
  eventId: string;
  /** Absolute wall-clock deadline in ms since epoch. */
  deadlineMs: number;
  /** Callback invoked when the deadline fires. Never awaited — must be fast. */
  callback: () => void;
}

export interface PersistedDeadline {
  eventId: string;
  deadlineMs: number;
}

export interface SchedulerOptions {
  /** Tick interval in ms. 100 = check deadlines 10x per second. */
  tickMs?: number;
  /**
   * Max number of deadlines to fire in one tick. Protects the event loop
   * against a backlog of thousands of past-due timers blocking for long.
   * Deadlines beyond the cap will fire on the next tick.
   */
  maxFirePerTick?: number;
  /**
   * Override for the current-time function. Only used by tests to advance
   * simulated wall-clock. Defaults to Date.now.
   */
  now?: () => number;
  /**
   * Override for the setInterval scheduler. Only used by tests.
   */
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (h: ReturnType<typeof setInterval>) => void;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Simple binary min-heap keyed by deadlineMs. Extracted so it can be
 * unit-tested in isolation from the scheduler's timer behavior.
 */
class DeadlineHeap {
  private arr: Deadline[] = [];

  size(): number {
    return this.arr.length;
  }

  peek(): Deadline | undefined {
    return this.arr[0];
  }

  push(d: Deadline): void {
    this.arr.push(d);
    this.siftUp(this.arr.length - 1);
  }

  /** Pop the earliest deadline. Returns undefined if empty. */
  pop(): Deadline | undefined {
    if (this.arr.length === 0) return undefined;
    const top = this.arr[0];
    const last = this.arr.pop();
    if (this.arr.length > 0 && last !== undefined) {
      this.arr[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /**
   * Remove an entry by (tableId, eventId). O(n); we expect pending queues
   * to stay small (<1000 items across all tables) so this is fine.
   */
  remove(tableId: string, eventId: string): Deadline | undefined {
    const idx = this.arr.findIndex((d) => d.tableId === tableId && d.eventId === eventId);
    if (idx === -1) return undefined;
    const removed = this.arr[idx];
    const last = this.arr.pop();
    if (idx < this.arr.length && last !== undefined) {
      this.arr[idx] = last;
      // Either sift up or down depending on where the replacement lands
      this.siftUp(idx);
      this.siftDown(idx);
    }
    return removed;
  }

  /** Drop every entry for a tableId. Returns how many were removed. */
  removeTable(tableId: string): number {
    const before = this.arr.length;
    this.arr = this.arr.filter((d) => d.tableId !== tableId);
    this.reheapify();
    return before - this.arr.length;
  }

  /** Read-only snapshot of all entries for a tableId (used for persistence). */
  listTable(tableId: string): Deadline[] {
    return this.arr.filter((d) => d.tableId === tableId);
  }

  /** Read-only all entries — used by tests. */
  listAll(): Deadline[] {
    return [...this.arr];
  }

  clear(): void {
    this.arr = [];
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.arr[parent].deadlineMs <= this.arr[i].deadlineMs) break;
      [this.arr[parent], this.arr[i]] = [this.arr[i], this.arr[parent]];
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.arr.length;
    for (;;) {
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      let smallest = i;
      if (left < n && this.arr[left].deadlineMs < this.arr[smallest].deadlineMs) smallest = left;
      if (right < n && this.arr[right].deadlineMs < this.arr[smallest].deadlineMs) smallest = right;
      if (smallest === i) break;
      [this.arr[smallest], this.arr[i]] = [this.arr[i], this.arr[smallest]];
      i = smallest;
    }
  }

  private reheapify(): void {
    for (let i = (this.arr.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
  }
}

// ─── Public scheduler ─────────────────────────────────────────────────────────

export class DeadlineScheduler {
  private heap = new DeadlineHeap();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private readonly tickMs: number;
  private readonly maxFirePerTick: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (h: ReturnType<typeof setInterval>) => void;
  private running = false;

  constructor(opts: SchedulerOptions = {}) {
    this.tickMs = opts.tickMs ?? 100;
    this.maxFirePerTick = opts.maxFirePerTick ?? 128;
    this.now = opts.now ?? Date.now;
    this.setIntervalFn = opts.setInterval ?? setInterval;
    this.clearIntervalFn = opts.clearInterval ?? clearInterval;
  }

  /** Start the tick loop. Safe to call twice. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tickHandle = this.setIntervalFn(() => this.tick(), this.tickMs);
  }

  /** Stop the tick loop and clear all pending deadlines. */
  stop(): void {
    if (this.tickHandle) {
      this.clearIntervalFn(this.tickHandle);
      this.tickHandle = null;
    }
    this.heap.clear();
    this.running = false;
  }

  /**
   * Schedule a deadline. Re-scheduling the same (tableId, eventId) replaces
   * the prior one — idempotent by design so callers don't have to cancel
   * before re-scheduling.
   */
  schedule(d: Deadline): void {
    // Idempotent: purge any prior entry with the same key
    this.heap.remove(d.tableId, d.eventId);
    this.heap.push(d);
  }

  /** Cancel one. Safe on unknown keys. */
  cancel(tableId: string, eventId: string): void {
    this.heap.remove(tableId, eventId);
  }

  /** Cancel every deadline for a tableId. */
  cancelAll(tableId: string): number {
    return this.heap.removeTable(tableId);
  }

  /**
   * Dump pending deadlines for a tableId in a JSON-serializable shape.
   * The callback is intentionally omitted — callers rehydrate with their
   * own callbacks after a restart. Use this inside
   * ServerTableEngine.saveSnapshot().
   */
  persistPending(tableId: string): PersistedDeadline[] {
    return this.heap
      .listTable(tableId)
      .map((d) => ({ eventId: d.eventId, deadlineMs: d.deadlineMs }));
  }

  /**
   * Reinstall pending deadlines from a persisted snapshot. Any deadline whose
   * deadlineMs is already past fires on the next tick (not immediately —
   * lets the caller finish their own setup before firing callbacks).
   */
  rehydrate(
    tableId: string,
    entries: PersistedDeadline[],
    lookupCallback: (eventId: string) => (() => void) | undefined
  ): void {
    for (const e of entries) {
      const cb = lookupCallback(e.eventId);
      if (!cb) continue; // unknown event — caller chose not to resurrect
      this.heap.push({
        tableId,
        eventId: e.eventId,
        deadlineMs: e.deadlineMs,
        callback: cb,
      });
    }
  }

  // ─── Metrics (test + /ws-metrics observability) ─────────────────────────

  size(): number {
    return this.heap.size();
  }

  nextDeadlineMs(): number | undefined {
    return this.heap.peek()?.deadlineMs;
  }

  /** Force a tick even if no interval is running — exposed for tests. */
  tickNow(): number {
    return this.tick();
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Fire every deadline whose deadlineMs is ≤ now, up to maxFirePerTick.
   * Callbacks are wrapped in try/catch so one throwing doesn't break the
   * scheduler. Returns the number fired.
   */
  private tick(): number {
    const now = this.now();
    let fired = 0;
    while (fired < this.maxFirePerTick) {
      const top = this.heap.peek();
      if (!top || top.deadlineMs > now) break;
      this.heap.pop();
      try {
        top.callback();
      } catch (err) {
        // Scheduler stays up even on throwing callbacks. Route through
        // reportError so Sentry captures it alongside the console log.
        reportError(err, 'DeadlineScheduler.callback_threw', {
          tableId: top.tableId,
          eventId: top.eventId,
          deadlineMs: top.deadlineMs,
        });
      }
      fired++;
    }
    return fired;
  }
}

// Singleton for convenience. ServerTableEngine uses this; tests construct
// their own instances.
export const deadlineScheduler = new DeadlineScheduler();

// Exposed for tests and reuse
export { DeadlineHeap };
