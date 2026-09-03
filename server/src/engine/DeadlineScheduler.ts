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
   * C18: stop firing once a single tick has spent this long, even if more
   * deadlines are due. Whatever is left is picked up on the next tick, so a
   * burst degrades into slight lateness instead of a stalled event loop.
   */
  maxTickBudgetMs?: number;
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
 * Binary min-heap keyed by deadlineMs, with O(1) key lookup.
 *
 * C18 FIX (2026-08-09): every mutation used to be O(n) in the TOTAL number of
 * pending deadlines across every table, because `remove` did an `Array.findIndex`
 * and `removeTable`/`listTable` did a full `filter`. That would be fine if the
 * queue were cold, but it is the hottest path in the engine: arming a turn timer
 * calls schedule(), which removes-then-pushes, and every table also re-arms a
 * heartbeat every 10 seconds. At 300 tables that is a linear scan of the whole
 * queue several times a second, and the cost grows with the square of the table
 * count.
 *
 * Two indexes now ride alongside the array:
 *   - `pos`     key -> current array index, so remove() is O(log n)
 *   - `byTable` tableId -> its keys, so removeTable()/listTable() are O(k) in
 *               that table's own entries rather than O(n) in everyone's
 *
 * Both are maintained by `place()`, which is the ONLY way an element is written
 * into the array — that invariant is what keeps the index honest through every
 * sift. There is an `assertConsistent()` escape hatch for tests.
 */
class DeadlineHeap {
  private arr: Deadline[] = [];
  /** key -> index in `arr`. */
  private pos = new Map<string, number>();
  /** tableId -> set of keys belonging to it. */
  private byTable = new Map<string, Set<string>>();

  private static key(tableId: string, eventId: string): string {
    // Length-prefixed rather than separator-joined: `${a}:${b}` is ambiguous if
    // either id can contain the separator, and a NUL separator — while
    // unambiguous — is a genuine hazard to transfer through tooling. Prefixing
    // the first id's length makes the encoding injective with no escaping and no
    // reserved character at all.
    return `${tableId.length}:${tableId}:${eventId}`;
  }

  /** The single writer into `arr`. Keeps `pos` in step with every move. */
  private place(i: number, d: Deadline): void {
    this.arr[i] = d;
    this.pos.set(DeadlineHeap.key(d.tableId, d.eventId), i);
  }

  private track(d: Deadline): void {
    let set = this.byTable.get(d.tableId);
    if (!set) {
      set = new Set();
      this.byTable.set(d.tableId, set);
    }
    set.add(DeadlineHeap.key(d.tableId, d.eventId));
  }

  private untrack(d: Deadline): void {
    const k = DeadlineHeap.key(d.tableId, d.eventId);
    this.pos.delete(k);
    const set = this.byTable.get(d.tableId);
    if (set) {
      set.delete(k);
      if (set.size === 0) this.byTable.delete(d.tableId);
    }
  }

  size(): number {
    return this.arr.length;
  }

  peek(): Deadline | undefined {
    return this.arr[0];
  }

  push(d: Deadline): void {
    // Defensive: the index can only hold one entry per key, so a duplicate push
    // would desynchronise it. Callers already remove-then-push, but making push
    // itself replace keeps the invariant true regardless of caller discipline.
    this.remove(d.tableId, d.eventId);
    const i = this.arr.length;
    this.arr.push(d);
    this.place(i, d);
    this.track(d);
    this.siftUp(i);
  }

  /** Pop the earliest deadline. Returns undefined if empty. */
  pop(): Deadline | undefined {
    if (this.arr.length === 0) return undefined;
    const top = this.arr[0];
    const last = this.arr.pop()!;
    this.untrack(top);
    if (this.arr.length > 0 && last !== top) {
      this.place(0, last);
      this.siftDown(0);
    }
    return top;
  }

  /** Remove an entry by (tableId, eventId). O(log n) via the index. */
  remove(tableId: string, eventId: string): Deadline | undefined {
    const idx = this.pos.get(DeadlineHeap.key(tableId, eventId));
    if (idx === undefined) return undefined;
    const removed = this.arr[idx];
    const last = this.arr.pop()!;
    this.untrack(removed);
    if (idx < this.arr.length) {
      this.place(idx, last);
      // The replacement can belong either above or below its new slot.
      this.siftUp(idx);
      this.siftDown(this.pos.get(DeadlineHeap.key(last.tableId, last.eventId))!);
    }
    return removed;
  }

  /** Drop every entry for a tableId. O(k) in that table's entries. */
  removeTable(tableId: string): number {
    const keys = this.byTable.get(tableId);
    if (!keys || keys.size === 0) return 0;
    let removed = 0;
    // Snapshot: remove() mutates the set we are iterating.
    for (const k of [...keys]) {
      const idx = this.pos.get(k);
      if (idx === undefined) continue;
      const d = this.arr[idx];
      if (this.remove(d.tableId, d.eventId)) removed++;
    }
    return removed;
  }

  /** Read-only snapshot of all entries for a tableId (used for persistence). */
  listTable(tableId: string): Deadline[] {
    const keys = this.byTable.get(tableId);
    if (!keys) return [];
    const out: Deadline[] = [];
    for (const k of keys) {
      const idx = this.pos.get(k);
      if (idx !== undefined) out.push(this.arr[idx]);
    }
    return out;
  }

  /** Read-only all entries — used by tests. */
  listAll(): Deadline[] {
    return [...this.arr];
  }

  clear(): void {
    this.arr = [];
    this.pos.clear();
    this.byTable.clear();
  }

  /**
   * Test hook: verify the indexes still describe the array exactly, and that the
   * heap property holds. An index that silently drifts would turn cancel() into
   * a no-op and leave a fired-but-cancelled timer behind, so this is worth
   * asserting directly rather than inferring from behaviour.
   */
  assertConsistent(): void {
    if (this.pos.size !== this.arr.length) {
      throw new Error(`DeadlineHeap: pos has ${this.pos.size} keys for ${this.arr.length} entries`);
    }
    let tracked = 0;
    for (const set of this.byTable.values()) tracked += set.size;
    if (tracked !== this.arr.length) {
      throw new Error(
        `DeadlineHeap: byTable tracks ${tracked} keys for ${this.arr.length} entries`
      );
    }
    for (let i = 0; i < this.arr.length; i++) {
      const d = this.arr[i];
      const k = DeadlineHeap.key(d.tableId, d.eventId);
      if (this.pos.get(k) !== i) {
        throw new Error(`DeadlineHeap: pos[${k}] = ${this.pos.get(k)}, expected ${i}`);
      }
      if (!this.byTable.get(d.tableId)?.has(k)) {
        throw new Error(`DeadlineHeap: byTable missing ${k}`);
      }
      const parent = (i - 1) >> 1;
      if (i > 0 && this.arr[parent].deadlineMs > d.deadlineMs) {
        throw new Error(`DeadlineHeap: heap property violated at ${i}`);
      }
    }
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.arr[parent].deadlineMs <= this.arr[i].deadlineMs) break;
      const a = this.arr[parent];
      const b = this.arr[i];
      this.place(parent, b);
      this.place(i, a);
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
      const a = this.arr[smallest];
      const b = this.arr[i];
      this.place(smallest, b);
      this.place(i, a);
      i = smallest;
    }
  }
}

// ─── Public scheduler ─────────────────────────────────────────────────────────

export class DeadlineScheduler {
  private heap = new DeadlineHeap();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private readonly tickMs: number;
  private readonly maxFirePerTick: number;
  private readonly maxTickBudgetMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (h: ReturnType<typeof setInterval>) => void;
  private running = false;

  constructor(opts: SchedulerOptions = {}) {
    this.tickMs = opts.tickMs ?? 100;
    // C18: the old default of 128 with a 100 ms tick imposed a hard process
    // ceiling of ~1,280 timer fires per second — reached well before the table
    // count that the rest of the engine can handle, and silently: deadlines just
    // started running late. The real thing worth protecting is event-loop
    // responsiveness, so the count cap is now generous and a wall-clock budget
    // does the actual limiting.
    this.maxFirePerTick = opts.maxFirePerTick ?? 4096;
    this.maxTickBudgetMs = opts.maxTickBudgetMs ?? 20;
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
    const budgetEndsAt = now + this.maxTickBudgetMs;
    let fired = 0;
    while (fired < this.maxFirePerTick) {
      const top = this.heap.peek();
      if (!top || top.deadlineMs > now) break;
      // C18: check the wall-clock budget between fires, not just the count.
      // `fired > 0` guarantees forward progress — one deadline always runs, so a
      // single slow callback can never starve the queue completely.
      if (fired > 0 && this.now() >= budgetEndsAt) break;
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
