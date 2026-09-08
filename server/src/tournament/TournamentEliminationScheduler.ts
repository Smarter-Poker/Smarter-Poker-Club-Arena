/**
 * Process-wide tournament elimination scheduler.
 *
 * A tournament used to own a five-second interval. With hundreds of RUNNING
 * tournaments that fanned out hundreds of identical database walks at once,
 * saturated the one Node event loop, and delayed the table/socket timers the
 * sweep is supposed to support. There is deliberately ONE scheduler now:
 * durable state transitions and their exact deadlines wake it, and a hard
 * concurrency ceiling keeps the event loop available for dealing and
 * broadcasts. It never scans every tournament on a wall-clock cadence.
 */
import {
  alwaysOnRegistry,
  eliminationSweepOverrunsTotal,
} from '../observability/engineInstruments.js';
import { reportError } from '../services/errorReporter.js';
import { ELIMINATION_SWEEP_STUCK_MS } from './eliminationLock.js';

export const DEFAULT_MAX_CONCURRENT_SWEEPS = 4;
// The engine signals only after its awaited stack-sync step now. A zero-delay
// process timer keeps the callback fire-and-forget without guessing how long
// settlement will take under load.
export const DEFAULT_EVENT_WAKE_DELAY_MS = 0;
export const DEFAULT_SWEEP_WARN_MS = ELIMINATION_SWEEP_STUCK_MS + 1_000;
export const DEFAULT_URGENT_BURST = 3;

const registeredGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_registered',
  'Tournament managers registered with the one process-wide elimination scheduler.'
);
const queueDepthGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_queue_depth',
  'Tournament elimination sweeps waiting for a bounded scheduler slot.'
);
const slotsInflightGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_slots_inflight',
  'Process-wide scheduler slots currently assigned to tournament elimination sweeps.'
);
const stalledSlotsGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_stalled_slots',
  'Physical tournament elimination promises still unresolved after the sweep warning budget.'
);
const oldestWaitGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_oldest_wait_ms',
  'Age in milliseconds of the oldest queued tournament elimination sweep.'
);
const dispatchTotal = alwaysOnRegistry.counter(
  'poker_tournament_elimination_scheduler_dispatch_total',
  'Bounded tournament elimination scheduler lifecycle events (outcome=completed|failed|timed_out); timed_out is observational and never releases a live promise slot.'
);
for (const outcome of ['completed', 'failed', 'timed_out']) {
  dispatchTotal.inc(0, { outcome });
}

type QueueKind = 'urgent' | 'routine';

export interface TournamentEliminationRegistration {
  tournamentId: string;
  run: (signal: AbortSignal) => Promise<void>;
  isActive?: () => boolean;
}

export interface TournamentEliminationSchedulerOptions {
  maxConcurrent?: number;
  eventWakeDelayMs?: number;
  sweepWarnMs?: number;
  urgentBurst?: number;
  startTimers?: boolean;
  now?: () => number;
}

interface Entry extends TournamentEliminationRegistration {
  registered: boolean;
  queuedAs: QueueKind | null;
  dirtyAs: QueueKind | null;
  running: boolean;
  warned: boolean;
  enqueuedAt: number | null;
  pendingWakeAt: number | null;
  pendingWakeAs: QueueKind | null;
  pendingWakeOrder: number | null;
  abortController: AbortController | null;
}

export interface TournamentEliminationSchedulerSnapshot {
  capacity: number;
  registered: number;
  queued: number;
  running: number;
  stalled: number;
  pendingWakes: number;
  oldestWaitMs: number;
}

/** Prefer urgent correctness work, but guarantee routine causal work a slot. */
function strongerQueueKind(a: QueueKind | null, b: QueueKind): QueueKind {
  return a === 'urgent' || b === 'urgent' ? 'urgent' : 'routine';
}

export class TournamentEliminationScheduler {
  private readonly maxConcurrent: number;
  private readonly eventWakeDelayMs: number;
  private readonly sweepWarnMs: number;
  private readonly urgentBurst: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  /** Physical promises, including unregistered/replaced entries, by tournament. */
  private readonly activeTournamentIds = new Set<string>();
  private readonly activeEntries = new Set<Entry>();
  private readonly urgentQueue: Entry[] = [];
  private readonly routineQueue: Entry[] = [];
  private runningCount = 0;
  private urgentRunStreak = 0;
  private wakeOrder = 0;
  private allSlotsStalledReported = false;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TournamentEliminationSchedulerOptions = {}) {
    this.maxConcurrent = Math.max(
      1,
      Math.floor(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SWEEPS)
    );
    this.eventWakeDelayMs = Math.max(0, options.eventWakeDelayMs ?? DEFAULT_EVENT_WAKE_DELAY_MS);
    this.sweepWarnMs = Math.max(0, options.sweepWarnMs ?? DEFAULT_SWEEP_WARN_MS);
    this.urgentBurst = Math.max(1, Math.floor(options.urgentBurst ?? DEFAULT_URGENT_BURST));
    this.now = options.now ?? (() => Date.now());

    if (options.startTimers !== false) {
      // Wait age must keep moving while the queue is wedged; state-change-only
      // updates would make the incident gauge freeze at a reassuring number.
      this.metricsTimer = setInterval(() => this.refreshMetrics(), 1_000);
      this.metricsTimer.unref?.();
    }
    this.refreshMetrics();
  }

  register(registration: TournamentEliminationRegistration): () => void {
    const previous = this.entries.get(registration.tournamentId);
    if (previous) this.remove(previous);

    const entry: Entry = {
      ...registration,
      registered: true,
      queuedAs: null,
      dirtyAs: null,
      running: false,
      warned: false,
      enqueuedAt: null,
      pendingWakeAt: null,
      pendingWakeAs: null,
      pendingWakeOrder: null,
      abortController: null,
    };
    this.entries.set(entry.tournamentId, entry);
    // Manager admission is itself a causal event. Its first pass reconstructs
    // all persisted obligations before the manager starts accepting new work.
    this.enqueue(entry, 'routine');

    return () => {
      if (this.entries.get(entry.tournamentId) !== entry) return;
      this.remove(entry);
      this.pump();
    };
  }

  /** Wake from a post-settlement hand completion whose final stacks contain a bust. */
  wake(tournamentId: string): boolean {
    return this.scheduleWake(tournamentId, this.eventWakeDelayMs, 'urgent');
  }

  /**
   * Schedule narrow follow-up work on the same one process timer. Add-on
   * retries, final-table deal polling and post-expansion seating use this
   * instead of restoring one timeout/interval per tournament.
   */
  wakeAfter(tournamentId: string, delayMs: number): void {
    this.scheduleWake(tournamentId, delayMs, 'routine');
  }

  /**
   * Delay known correctness work without putting it behind routine causal
   * follow-ups. Feature deadlines deliberately remain on wakeAfter().
   */
  wakeUrgentAfter(tournamentId: string, delayMs: number): void {
    this.scheduleWake(tournamentId, delayMs, 'urgent');
  }

  private scheduleWake(tournamentId: string, delayMs: number, kind: QueueKind): boolean {
    const entry = this.entries.get(tournamentId);
    if (!entry || !entry.registered || entry.isActive?.() === false) return false;

    const dueAt = this.now() + Math.max(0, delayMs);
    if (entry.pendingWakeAt === null || dueAt < entry.pendingWakeAt) {
      entry.pendingWakeAt = dueAt;
      if (entry.pendingWakeOrder === null) entry.pendingWakeOrder = this.wakeOrder++;
      // Pulling an earlier feature wake forward must never demote an already
      // known bust/rebuy/bounty retry.
      entry.pendingWakeAs = strongerQueueKind(entry.pendingWakeAs, kind);
    } else {
      // A later bust may safely pull priority forward to an already earlier
      // feature wake. There is still only one pending wake per tournament.
      entry.pendingWakeAs = strongerQueueKind(entry.pendingWakeAs, kind);
    }
    this.armWakeTimer();
    this.refreshMetrics();
    return true;
  }

  snapshot(): TournamentEliminationSchedulerSnapshot {
    let queued = 0;
    let pendingWakes = 0;
    let oldestEnqueuedAt: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.queuedAs) {
        queued++;
        if (
          entry.enqueuedAt !== null &&
          (oldestEnqueuedAt === null || entry.enqueuedAt < oldestEnqueuedAt)
        ) {
          oldestEnqueuedAt = entry.enqueuedAt;
        }
      }
      if (entry.pendingWakeAt !== null) pendingWakes++;
    }
    return {
      capacity: this.maxConcurrent,
      registered: this.entries.size,
      queued,
      running: this.runningCount,
      stalled: Array.from(this.activeEntries).filter((entry) => entry.running && entry.warned)
        .length,
      pendingWakes,
      oldestWaitMs: oldestEnqueuedAt === null ? 0 : Math.max(0, this.now() - oldestEnqueuedAt),
    };
  }

  /** Test/process teardown only. Manager teardown uses its unregister closure. */
  stop(): void {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.metricsTimer = null;
    this.wakeTimer = null;
    for (const entry of this.entries.values()) {
      entry.registered = false;
      entry.abortController?.abort();
    }
    this.entries.clear();
    this.urgentQueue.length = 0;
    this.routineQueue.length = 0;
    this.activeTournamentIds.clear();
    this.activeEntries.clear();
    this.runningCount = 0;
    this.allSlotsStalledReported = false;
    this.refreshMetrics();
  }

  private remove(entry: Entry): void {
    entry.registered = false;
    entry.abortController?.abort();
    entry.queuedAs = null;
    entry.dirtyAs = null;
    entry.enqueuedAt = null;
    entry.pendingWakeAt = null;
    entry.pendingWakeAs = null;
    entry.pendingWakeOrder = null;
    if (this.entries.get(entry.tournamentId) === entry) {
      this.entries.delete(entry.tournamentId);
    }
    this.armWakeTimer();
    this.refreshMetrics();
  }

  private enqueue(entry: Entry, kind: QueueKind, pumpNow = true): void {
    if (!entry.registered || entry.isActive?.() === false) return;
    if (entry.running) {
      entry.dirtyAs = strongerQueueKind(entry.dirtyAs, kind);
      return;
    }
    if (entry.queuedAs) {
      if (entry.queuedAs === 'routine' && kind === 'urgent') {
        // Upgrade in place. The old routine-array reference becomes a harmless
        // stale item; logical queue depth remains one.
        entry.queuedAs = 'urgent';
        this.urgentQueue.push(entry);
      }
      return;
    }
    entry.queuedAs = kind;
    entry.enqueuedAt = this.now();
    (kind === 'urgent' ? this.urgentQueue : this.routineQueue).push(entry);
    this.refreshMetrics();
    if (pumpNow) this.pump();
  }

  private armWakeTimer(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    let earliest: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.pendingWakeAt !== null && (earliest === null || entry.pendingWakeAt < earliest)) {
        earliest = entry.pendingWakeAt;
      }
    }
    if (earliest === null) return;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        const now = this.now();
        const due: Array<{
          entry: Entry;
          dueAt: number;
          order: number;
          kind: QueueKind;
        }> = [];
        for (const entry of this.entries.values()) {
          if (entry.pendingWakeAt !== null && entry.pendingWakeAt <= now) {
            due.push({
              entry,
              dueAt: entry.pendingWakeAt,
              order: entry.pendingWakeOrder ?? Number.MAX_SAFE_INTEGER,
              kind: entry.pendingWakeAs ?? 'routine',
            });
            entry.pendingWakeAt = null;
            entry.pendingWakeAs = null;
            entry.pendingWakeOrder = null;
          }
        }
        // A delayed event loop can make several deadlines due together. Do not
        // let Map registration order or an eager pump invert them: enqueue the
        // whole due batch by deadline and stable scheduling order, then pump
        // once. Queue-kind priority is applied later by next().
        due
          .sort((a, b) => a.dueAt - b.dueAt || a.order - b.order)
          .forEach(({ entry, kind }) => this.enqueue(entry, kind, false));
        this.pump();
        this.armWakeTimer();
        this.refreshMetrics();
      },
      Math.max(0, earliest - this.now())
    );
    this.wakeTimer.unref?.();
  }

  private shiftValid(queue: Entry[], kind: QueueKind): Entry | null {
    // A stopped/replaced manager's old promise can still be unwinding. Scan
    // each queued reference at most once and rotate a replacement behind it;
    // this prevents two generations of one tournament from colliding while
    // still allowing unrelated tournaments to use the other slots.
    const candidates = queue.length;
    for (let scanned = 0; scanned < candidates; scanned++) {
      const entry = queue.shift()!;
      if (
        entry.registered &&
        this.entries.get(entry.tournamentId) === entry &&
        entry.queuedAs === kind
      ) {
        if (this.activeTournamentIds.has(entry.tournamentId)) {
          queue.push(entry);
          continue;
        }
        return entry;
      }
    }
    return null;
  }

  private next(): Entry | null {
    const preferUrgent =
      this.urgentQueue.length > 0 &&
      (this.urgentRunStreak < this.urgentBurst || this.routineQueue.length === 0);
    if (preferUrgent) {
      const urgent = this.shiftValid(this.urgentQueue, 'urgent');
      if (urgent) {
        this.urgentRunStreak++;
        return urgent;
      }
    }
    const routine = this.shiftValid(this.routineQueue, 'routine');
    if (routine) {
      this.urgentRunStreak = 0;
      return routine;
    }
    const urgent = this.shiftValid(this.urgentQueue, 'urgent');
    if (urgent) {
      this.urgentRunStreak++;
      return urgent;
    }
    return null;
  }

  private pump(): void {
    while (this.runningCount < this.maxConcurrent) {
      const entry = this.next();
      if (!entry) break;
      entry.queuedAs = null;
      entry.enqueuedAt = null;
      if (entry.isActive?.() === false) continue;
      this.dispatch(entry);
    }
    this.refreshMetrics();
  }

  private dispatch(entry: Entry): void {
    entry.running = true;
    entry.abortController = new AbortController();
    this.activeTournamentIds.add(entry.tournamentId);
    this.activeEntries.add(entry);
    this.runningCount++;
    this.refreshMetrics();

    let settled = false;
    let warningTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: 'completed' | 'failed'): void => {
      if (settled) return;
      settled = true;
      if (warningTimer) clearTimeout(warningTimer);
      entry.running = false;
      entry.abortController = null;
      entry.warned = false;
      this.activeTournamentIds.delete(entry.tournamentId);
      this.activeEntries.delete(entry);
      this.runningCount = Math.max(0, this.runningCount - 1);
      dispatchTotal.inc(1, { outcome });
      this.allSlotsStalledReported = false;

      const rerun = entry.dirtyAs;
      entry.dirtyAs = null;
      if (entry.registered && this.entries.get(entry.tournamentId) === entry && rerun) {
        // Tail insertion is the fairness rule: a hot tournament gets one
        // coalesced rerun, after peers that were already waiting.
        this.enqueue(entry, rerun);
      }
      this.pump();
    };

    if (this.sweepWarnMs > 0) {
      warningTimer = setTimeout(() => {
        if (settled) return;
        // Observation, not release. The promise remains counted against the
        // hard cap until it actually settles; otherwise four timed-out calls
        // every minute become unbounded real concurrency behind a reassuring
        // scheduler gauge. Supabase attempts carry their own 15s aborts, so a
        // genuinely quarantined slot is exceptional and visible through
        // slots_inflight + oldest_wait_ms.
        entry.warned = true;
        dispatchTotal.inc(1, { outcome: 'timed_out' });
        // Preserve the established incident series while changing its
        // ownership semantics: a warning is observable, but no live promise
        // is ever "forced" off its slot.
        eliminationSweepOverrunsTotal.inc(1, { outcome: 'warned' });
        this.refreshMetrics();
        const snapshot = this.snapshot();
        if (
          snapshot.running >= snapshot.capacity &&
          snapshot.stalled >= snapshot.capacity &&
          !this.allSlotsStalledReported
        ) {
          this.allSlotsStalledReported = true;
          reportError(
            new Error(
              `All ${this.maxConcurrent} tournament elimination scheduler slots are still unresolved after ${this.sweepWarnMs}ms; queue depth ${snapshot.queued}. Slots remain quarantined so underlying work cannot exceed the cap; correlate with whole-fleet deal progress before any worker restart.`
            ),
            'Tournament.elimination_scheduler_all_slots_stalled'
          );
        }
      }, this.sweepWarnMs);
      warningTimer.unref?.();
    }

    Promise.resolve()
      .then(() => entry.run(entry.abortController!.signal))
      .then(
        () => finish('completed'),
        (error) => {
          reportError(error, 'Tournament.elimination_scheduler_run_failed', {
            tournamentId: entry.tournamentId,
          });
          finish('failed');
        }
      );
  }

  private refreshMetrics(): void {
    const snapshot = this.snapshot();
    registeredGauge.set(snapshot.registered);
    queueDepthGauge.set(snapshot.queued);
    slotsInflightGauge.set(snapshot.running);
    stalledSlotsGauge.set(snapshot.stalled);
    oldestWaitGauge.set(snapshot.oldestWaitMs);
  }
}

/** The only live scheduler in this Node process. */
export const tournamentEliminationScheduler = new TournamentEliminationScheduler();
