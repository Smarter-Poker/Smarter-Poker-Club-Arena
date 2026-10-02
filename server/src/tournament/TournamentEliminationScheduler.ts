import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  TournamentManagerBase,
  TournamentDiagnosticSelection,
} from './TournamentManagerBase.js';
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
/**
 * A FIELD THAT CANNOT DEAL IS NOT WAITING BEHIND ONE THAT CAN (2026-09-29).
 *
 * Read on production at 04:30 UTC on 2026-09-29, engine c0c986ad: 307
 * managers registered, 264 queued, all four slots busy, the oldest waiter at
 * 316 s, and a sweep averaging 5 to 7 s (event loop p50 69 ms, every stage a
 * chain of awaited round trips). A per-manager snapshot of the queue at
 * 04:34 put 222 of 296 managers in the urgent lane, almost all of them live
 * Sit and Gos and Spins with a bust to record, so "urgent" had become plain
 * FIFO over the whole platform and any one manager was admitted about once
 * every five minutes.
 *
 * That cadence is survivable for a Sit and Go whose table keeps dealing. It
 * freezes a tournament whose field is spread one player to a table, because
 * a table with one player cannot deal and the only thing that can make it
 * deal again is the balancer, one break per admission. Morning Free Buy
 * 6a18ddaa held 12 players on 12 tables and $100 Freeroll c65c414d 18 on 18,
 * each re-arming its five-second balance redrive and each served once per
 * queue cycle: c65c414d merged one table between 04:22 and 04:34.
 *
 * So consolidation is its own lane with its own slot. A manager is marked
 * consolidating by its balance stage when that stage leaves table-break or
 * seat-move work outstanding, and unmarked by the first balance stage that
 * finishes with none. While marked, every wake it receives is served from
 * this lane. The lane has DEFAULT_CONSOLIDATION_SLOTS physical slots of its
 * own, beside the general cap, so a frozen field is served within seconds
 * and no Sit and Go is served one sweep later than it was; when the general
 * lanes are empty a consolidating manager may also use a general slot. The
 * extra concurrency exists only while some field is actually being
 * consolidated, and it is one sweep.
 */
export const DEFAULT_CONSOLIDATION_SLOTS = 1;

/**
 * A DECIDED GAME IS NOT WAITING BEHIND LIVE ONES (2026-10-01).
 *
 * Read on production at 19:50-20:10 UTC on 2026-10-01: 622 managers
 * registered, 573 queued, oldest wait 283 s, about 1.9 dispatches a second.
 * 487 RUNNING Spins and Sit & Gos had one player left with chips for more than
 * fifteen minutes, their winners unpaid; Spin 82bcfdfa dealt its deciding hand
 * at 19:14:03, recorded its busts at 19:28:45 and paid at 19:50:52, one full
 * queue cycle per admission it needed. The median Spin completed in that
 * window was paid 44 minutes after its last hand.
 *
 * A manager declared decided (one table, at most one stack with chips) is
 * served from a decided lane that the general slots read first, but never
 * with more than all-but-one of them: live work always keeps a slot. The mark
 * is sticky for the registration (a decided field does not become live again;
 * the sweep stays the authority either way, the lane only orders admission),
 * and finishing the game unregisters it, so the lane shrinks the queue it
 * jumps instead of adding to it.
 */
export const DECIDED_LANE_LEAVES_LIVE_SLOTS = 1;

/**
 * A DECIDED GAME HAS SLOTS OF ITS OWN (2026-10-02).
 *
 * The decided lane above only ORDERS admission to the general slots, so a
 * decided game still waits for a general slot to come free, and while the
 * decided lane is long it waits for every decided game ahead of it as well.
 * Read on production 16:17-16:32 UTC on 2026-10-02, engine 1-b4b20b86: the
 * decided lane was 119 deep with its oldest waiter at 516 s, all three of the
 * general slots it may hold were busy, and the admission that recorded a
 * Spin's or Sit & Go's final bust waited a median 221 s for one (3 of 896
 * inside 15 s). The work behind each of those admissions takes seconds.
 *
 * So, like consolidation, decided work gets DEFAULT_DECIDED_SLOTS physical
 * slots of its own beside the general cap, served before it reaches for a
 * general slot. The extra concurrency exists only while a decided game is
 * actually waiting to be paid, it is bounded, and finishing the game retires
 * its manager, so this pool drains itself. A decided field's admission runs
 * from its last bust through its finish without yielding to the clock
 * (TournamentManagerEliminations completedStage), so one admission per game
 * is the normal case and the pool is sized for that.
 */
export const DEFAULT_DECIDED_SLOTS = 2;

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
const consolidationQueueDepthGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_consolidation_queue_depth',
  'Tournament sweeps waiting in the consolidation lane: managers whose balance stage left a table break or seat move outstanding.'
);
const consolidatingGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_consolidating',
  'Registered tournament managers currently marked consolidating (their field is being merged onto fewer tables).'
);
const decidedQueueDepthGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_decided_queue_depth',
  'Tournament sweeps waiting in the decided lane: managers whose field has one table and at most one stack with chips.'
);
const consolidationOldestWaitGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_consolidation_oldest_wait_ms',
  'Age in milliseconds of the oldest sweep waiting in the consolidation lane.'
);
const oldestWaitGauge = alwaysOnRegistry.gauge(
  'poker_tournament_elimination_scheduler_oldest_wait_ms',
  'Age in milliseconds of the oldest queued tournament elimination sweep.'
);
const dispatchTotal = alwaysOnRegistry.counter(
  'poker_tournament_elimination_scheduler_dispatch_total',
  'Bounded tournament elimination scheduler lifecycle events (outcome=completed|failed|timed_out); timed_out never releases a live promise slot, it opens one compensating slot beside it (at most maxConcurrent of them).'
);
for (const outcome of ['completed', 'failed', 'timed_out']) {
  dispatchTotal.inc(0, { outcome });
}

type QueueKind = 'consolidation' | 'decided' | 'urgent' | 'routine';
type SlotLane = 'consolidation' | 'decided' | 'general';

type ManagerSnapshot = ReturnType<TournamentManagerBase['getLifecycleDiagnosticSnapshot']>;
interface RegistrationDiagnostics {
  readonly managerInstanceId: string;
  readonly leaseGeneration: string | null;
  readonly operationIdFor: (operation: Promise<void>) => string | null;
  readonly snapshot: (selection: TournamentDiagnosticSelection) => ManagerSnapshot;
}

function diagnosticUuid(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

export function diagnosticTableIds(
  selection: TournamentDiagnosticSelection
): readonly string[] | undefined {
  const ids = selection.tableIds;
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => diagnosticUuid(id) === null)) {
    throw new Error('tournament_diagnostic_selection_limit');
  }
  const normalized = ids.map((id) => id.toLowerCase());
  if (new Set(normalized).size !== normalized.length)
    throw new Error('tournament_diagnostic_duplicate_table');
  return normalized;
}

function captureRegistrationDiagnostics(
  registration: TournamentEliminationRegistration
): RegistrationDiagnostics | null {
  try {
    const supplied = registration.diagnostics;
    if (!supplied) return null;
    const managerInstanceId = diagnosticUuid(supplied.managerInstanceId);
    const leaseGeneration =
      supplied.leaseGeneration === null ? null : diagnosticUuid(supplied.leaseGeneration);
    if (
      !managerInstanceId ||
      (supplied.leaseGeneration !== null && !leaseGeneration) ||
      typeof supplied.operationIdFor !== 'function' ||
      typeof supplied.snapshot !== 'function'
    )
      return null;
    return Object.freeze({
      managerInstanceId,
      leaseGeneration,
      operationIdFor: supplied.operationIdFor,
      snapshot: supplied.snapshot,
    });
  } catch {
    return null;
  }
}

export interface TournamentEliminationRegistration {
  tournamentId: string;
  run: (signal: AbortSignal) => Promise<void>;
  isActive?: () => boolean;
  diagnostics?: RegistrationDiagnostics;
}

export interface TournamentEliminationSchedulerOptions {
  maxConcurrent?: number;
  eventWakeDelayMs?: number;
  sweepWarnMs?: number;
  urgentBurst?: number;
  /** Physical slots reserved for the consolidation lane, beside maxConcurrent. */
  consolidationSlots?: number;
  /** Physical slots reserved for decided games, beside maxConcurrent. */
  decidedSlots?: number;
  startTimers?: boolean;
  now?: () => number;
}

interface Entry extends TournamentEliminationRegistration {
  diagnosticRegistrationId: string | null;
  diagnosticOwner: RegistrationDiagnostics | null;
  diagnosticOperationId: string | null;
  registered: boolean;
  queuedAs: QueueKind | null;
  /** Queue generation. A place in a lane is live only while it carries this. */
  queueTicket: number;
  dirtyAs: QueueKind | null;
  running: boolean;
  /** Which slot pool the current physical run holds; null while not running. */
  runningLane: SlotLane | null;
  /** Balance stage left consolidation work outstanding; every wake uses that lane. */
  consolidating: boolean;
  /** The field is decided; every wake uses the decided lane (sticky per registration). */
  decided: boolean;
  /** The current physical run was counted against the decided lane's share. */
  runningDecided: boolean;
  warned: boolean;
  enqueuedAt: number | null;
  pendingWakeAt: number | null;
  pendingWakeAs: QueueKind | null;
  pendingWakeOrder: number | null;
  abortController: AbortController | null;
}

/**
 * ONE PLACE IN ONE LANE (2026-09-11).
 *
 * The lanes used to hold bare entries and judged a reference live by asking
 * whether the entry was still queued as that lane's kind. Two orderings
 * followed from that, and the backlog after the 06:57 boot of c58dfafd ran
 * into both: queue depth 553 of 597 registered at 07:19, about 350 events
 * each re-arming an urgent pass five seconds after every sweep because they
 * still held a zero-stack 'playing' player, and 120 distinct events reaching
 * their finish attempt in the first 27 minutes, once each.
 *
 * An urgent wake for a tournament already waiting in the routine lane
 * "upgraded" it by pushing it onto the TAIL of the urgent lane and orphaning
 * its routine place. With the urgent lane that long, the upgrade was a
 * demotion. The entries most likely to receive a wake are the ones that have
 * waited longest, so they went to the back of the longer line with their
 * original enqueue time still counting, while routine entries queued after
 * them were served - poker_tournament_elimination_scheduler_oldest_wait_ms
 * read 49 s at 07:01 and 1,470 s at 07:42.
 *
 * And an orphaned routine reference came back to life the next time the same
 * tournament was queued as routine, because the kind matched again, so a busy
 * tournament could be served from a place it had taken minutes earlier, ahead
 * of peers that had been waiting ever since.
 *
 * A place now carries the queue generation (ticket) it was taken under. An
 * upgrade adds an urgent place under the SAME ticket and leaves the routine
 * place live, so the tournament is served at whichever of its two places the
 * scheduler reaches first, and dispatch ends the generation, which retires
 * both. Queue depth is still one per tournament, urgent work is still
 * preferred, and the routine turn after every urgent burst is unchanged.
 */
interface QueuedPlace {
  entry: Entry;
  ticket: number;
}

export interface TournamentEliminationSchedulerSnapshot {
  capacity: number;
  consolidationCapacity: number;
  registered: number;
  queued: number;
  running: number;
  stalled: number;
  pendingWakes: number;
  oldestWaitMs: number;
  consolidating: number;
  consolidationQueued: number;
  consolidationRunning: number;
  consolidationOldestWaitMs: number;
  decided: number;
  decidedQueued: number;
  /** Decided games running on general slots (bounded by all-but-one of them). */
  decidedRunning: number;
  /** The decided lane's own physical slots, and how many of them are running. */
  decidedCapacity: number;
  decidedLaneRunning: number;
}

const QUEUE_KIND_RANK: Record<QueueKind, number> = {
  routine: 0,
  urgent: 1,
  decided: 2,
  consolidation: 3,
};

/**
 * Prefer urgent correctness work, but guarantee routine causal work a slot.
 * Consolidation outranks both and is served from its own slot pool.
 */
function strongerQueueKind(a: QueueKind | null, b: QueueKind): QueueKind {
  if (a === null) return b;
  return QUEUE_KIND_RANK[a] >= QUEUE_KIND_RANK[b] ? a : b;
}

export class TournamentEliminationScheduler {
  private readonly maxConcurrent: number;
  private readonly eventWakeDelayMs: number;
  private readonly sweepWarnMs: number;
  private readonly urgentBurst: number;
  private readonly consolidationSlots: number;
  private readonly decidedSlots: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  /** Physical promises, including unregistered/replaced entries, by tournament. */
  private readonly activeTournamentIds = new Set<string>();
  private readonly activeEntries = new Set<Entry>();
  private readonly consolidationQueue: QueuedPlace[] = [];
  private readonly decidedQueue: QueuedPlace[] = [];
  private readonly urgentQueue: QueuedPlace[] = [];
  private readonly routineQueue: QueuedPlace[] = [];
  private runningCount = 0;
  /** General-slot runs of decided managers (a subset of runningCount). */
  private decidedRunningCount = 0;
  /** Physical runs holding a consolidation-lane slot (a subset of runningCount). */
  private consolidationRunningCount = 0;
  /** Physical runs holding a decided-lane slot of its own (a subset of runningCount). */
  private decidedLaneRunningCount = 0;
  private urgentRunStreak = 0;
  private wakeOrder = 0;
  private allSlotsStalledReported = false;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The deadline the armed wake timer is set for; null while no timer is armed. */
  private wakeTimerDueAt: number | null = null;
  private lastMetricsRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(options: TournamentEliminationSchedulerOptions = {}) {
    this.maxConcurrent = Math.max(
      1,
      Math.floor(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SWEEPS)
    );
    this.eventWakeDelayMs = Math.max(0, options.eventWakeDelayMs ?? DEFAULT_EVENT_WAKE_DELAY_MS);
    this.sweepWarnMs = Math.max(0, options.sweepWarnMs ?? DEFAULT_SWEEP_WARN_MS);
    this.urgentBurst = Math.max(1, Math.floor(options.urgentBurst ?? DEFAULT_URGENT_BURST));
    this.consolidationSlots = Math.max(
      0,
      Math.floor(options.consolidationSlots ?? DEFAULT_CONSOLIDATION_SLOTS)
    );
    this.decidedSlots = Math.max(0, Math.floor(options.decidedSlots ?? DEFAULT_DECIDED_SLOTS));
    this.now = options.now ?? (() => Date.now());

    if (options.startTimers !== false) {
      // Wait age must keep moving while the queue is wedged; state-change-only
      // updates would make the incident gauge freeze at a reassuring number.
      this.metricsTimer = setInterval(() => this.refreshMetrics(true), 1_000);
      this.metricsTimer.unref?.();
    }
    this.refreshMetrics(true);
  }

  /**
   * A STALLED SLOT IS REPLACED, NOT RELEASED (2026-09-16).
   *
   * A physical promise that is still unresolved after the warning budget
   * keeps its slot: releasing it would let the same tournament run twice and
   * would turn every slow minute into unbounded database concurrency, which
   * is the rule the quarantine test enshrines. But a slot that never comes
   * back is capacity gone for the life of the process, silently. On
   * 2026-09-16 three of the four slots were held by promises that had not
   * settled since 05:30, 07:33 and 15:17 UTC; the fourth served 1,609
   * registered tournaments one at a time, the oldest of them waiting 3.4
   * hours, and 804 events whose last player had already won were never
   * finished because the finish stage never got a turn.
   *
   * So each stalled promise opens one compensating slot beside it, and there
   * are never more compensating slots than the cap itself: real concurrency
   * is bounded at twice `maxConcurrent`, the stalled promise stays counted,
   * stays excluded from re-dispatch for its own tournament, and stays on the
   * `stalled_slots` gauge until it really settles.
   */
  private stalledCount(lane?: SlotLane): number {
    let stalled = 0;
    for (const entry of this.activeEntries) {
      if (entry.running && entry.warned && (lane === undefined || entry.runningLane === lane))
        stalled++;
    }
    return stalled;
  }

  /** General slots: urgent and routine work, and consolidation when they are idle. */
  private capacityNow(): number {
    return this.maxConcurrent + Math.min(this.stalledCount('general'), this.maxConcurrent);
  }

  /** The consolidation lane's own slots, with the same stall compensation rule. */
  private consolidationCapacityNow(): number {
    return (
      this.consolidationSlots +
      Math.min(this.stalledCount('consolidation'), this.consolidationSlots)
    );
  }

  /** The decided lane's own slots, with the same stall compensation rule. */
  private decidedCapacityNow(): number {
    return this.decidedSlots + Math.min(this.stalledCount('decided'), this.decidedSlots);
  }

  /** Physical runs on general slots: everything not on a reserved lane slot. */
  private generalRunningCount(): number {
    return this.runningCount - this.consolidationRunningCount - this.decidedLaneRunningCount;
  }

  /**
   * A DECIDED FIELD IS NEVER CONSOLIDATION WORK (2026-10-01).
   *
   * A consolidating manager's every wake is consolidation work - unless its
   * field is decided. A decided field is one table with at most one stack
   * left: it has nothing to merge, and its finish pass belongs to the decided
   * lane, which reads the general slots first. The consolidation lane is ONE
   * slot (DEFAULT_CONSOLIDATION_SLOTS).
   *
   * Measured on production 2026-10-01 22:29-22:50 UTC, engine 71825702: the
   * decided-but-RUNNING board marked every decided Spin and Sit & Go
   * consolidating, so 208 managers were consolidating and 207 were queued for
   * that one slot, oldest wait 743 s. The fields that really needed it waited
   * behind them and dealt nothing: Five-Card Reload 7e7dabf8 and a21f7007 (a
   * table break parked since 22:04), Sunday Deep Stack Satellite $25 d9cc8159
   * (a held qualifier boundary, no hand since 21:20), and the decided
   * satellite 1e0343b5 was woken 25 times without a sweep.
   */
  private laneFor(entry: Entry, kind: QueueKind): QueueKind {
    if (entry.decided) return 'decided';
    return entry.consolidating ? 'consolidation' : kind;
  }

  private queueFor(kind: QueueKind): QueuedPlace[] {
    return kind === 'consolidation'
      ? this.consolidationQueue
      : kind === 'decided'
        ? this.decidedQueue
        : kind === 'urgent'
          ? this.urgentQueue
          : this.routineQueue;
  }

  /**
   * Mark (or unmark) one manager as consolidating. Marking promotes whatever
   * it already has pending - a queued place, a deferred wake, a rerun owed by
   * its live pass - into the consolidation lane, keeping its original place
   * live exactly as an urgent upgrade does. Unmarking demotes nothing that is
   * already queued; it only stops later wakes from using the lane.
   */
  setConsolidating(tournamentId: string, consolidating: boolean): boolean {
    const entry = this.entries.get(tournamentId);
    if (!entry || !entry.registered) return false;
    if (entry.consolidating === consolidating) return true;
    entry.consolidating = consolidating;
    // A decided field keeps the decided lane (see laneFor).
    if (consolidating && !entry.decided) {
      if (entry.pendingWakeAs !== null) entry.pendingWakeAs = 'consolidation';
      if (entry.dirtyAs !== null) entry.dirtyAs = 'consolidation';
      if (entry.queuedAs !== null) {
        this.enqueue(entry, 'consolidation');
        return true;
      }
    }
    this.refreshMetrics();
    return true;
  }

  /**
   * Mark one manager's field decided for the rest of this registration.
   * Marking promotes whatever it already has pending into the decided lane,
   * keeping its original place live exactly as an urgent upgrade does.
   */
  setDecided(tournamentId: string): boolean {
    const entry = this.entries.get(tournamentId);
    if (!entry || !entry.registered) return false;
    if (entry.decided) return true;
    entry.decided = true;
    // Whatever it already has pending moves to the decided lane, including a
    // place in the consolidation lane: a decided field has nothing to merge
    // and must not hold the one consolidation slot's queue (see laneFor).
    if (entry.pendingWakeAs !== null) entry.pendingWakeAs = 'decided';
    if (entry.dirtyAs !== null) entry.dirtyAs = 'decided';
    if (entry.queuedAs !== null && entry.queuedAs !== 'decided') {
      // A new ticket retires the earlier place: a consolidation place left
      // live would still be served from the consolidation slot.
      entry.queuedAs = 'decided';
      entry.queueTicket++;
      this.decidedQueue.push({ entry, ticket: entry.queueTicket });
      this.refreshMetrics();
      this.pump();
      return true;
    }
    this.refreshMetrics();
    return true;
  }

  register(registration: TournamentEliminationRegistration): () => void {
    const previous = this.entries.get(registration.tournamentId);
    if (previous) this.remove(previous);

    const diagnosticOwner = captureRegistrationDiagnostics(registration);
    let diagnosticRegistrationId: string | null = null;
    try {
      diagnosticRegistrationId = randomUUID();
    } catch {
      /* unknown, not a scheduling failure */
    }
    const entry: Entry = {
      ...registration,
      diagnosticRegistrationId,
      diagnosticOwner,
      diagnosticOperationId: null,
      // A process-wide scheduler is invoked by many manager contexts. Its
      // timers and promise continuations inherit whichever manager woke it.
      // Restore each callback's registration context before invoking the
      // manager's own immutable authority binder. Never rebind or weaken the
      // data authority guard to make cross-tournament dispatch succeed.
      run: AsyncResource.bind(registration.run, 'TournamentElimination.run'),
      isActive: registration.isActive
        ? AsyncResource.bind(registration.isActive, 'TournamentElimination.isActive')
        : undefined,
      registered: true,
      queuedAs: null,
      queueTicket: 0,
      dirtyAs: null,
      running: false,
      runningLane: null,
      consolidating: false,
      decided: false,
      runningDecided: false,
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
    kind = this.laneFor(entry, kind);

    const dueAt = this.now() + Math.max(0, delayMs);
    if (entry.pendingWakeAt === null || dueAt < entry.pendingWakeAt) {
      entry.pendingWakeAt = dueAt;
      if (entry.pendingWakeOrder === null) entry.pendingWakeOrder = this.wakeOrder++;
      // Pulling an earlier feature wake forward must never demote an already
      // known bust/rebuy/bounty retry.
      entry.pendingWakeAs = strongerQueueKind(entry.pendingWakeAs, kind);
      // ONE WAKE IS NOT A WALK OVER EVERY ENTRY (2026-09-16). This used to
      // rescan all registered entries for the earliest deadline on every
      // call, and with 1,612 entries and a recovery pass waking decided
      // events thousands of times an hour that scan was measurable on the
      // one event loop. The timer already holds the earliest deadline it was
      // armed for; a new deadline only matters if it is earlier than that.
      if (this.wakeTimer === null || this.wakeTimerDueAt === null || dueAt < this.wakeTimerDueAt) {
        this.armWakeTimerAt(dueAt);
      }
    } else {
      // A later bust may safely pull priority forward to an already earlier
      // feature wake. There is still only one pending wake per tournament.
      entry.pendingWakeAs = strongerQueueKind(entry.pendingWakeAs, kind);
    }
    this.refreshMetrics();
    return true;
  }

  snapshot(): TournamentEliminationSchedulerSnapshot {
    let queued = 0;
    let pendingWakes = 0;
    let consolidating = 0;
    let consolidationQueued = 0;
    let decided = 0;
    let decidedQueued = 0;
    let oldestEnqueuedAt: number | null = null;
    let oldestConsolidationAt: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.consolidating) consolidating++;
      if (entry.decided) decided++;
      if (entry.queuedAs === 'decided') decidedQueued++;
      if (entry.queuedAs) {
        queued++;
        if (
          entry.enqueuedAt !== null &&
          (oldestEnqueuedAt === null || entry.enqueuedAt < oldestEnqueuedAt)
        ) {
          oldestEnqueuedAt = entry.enqueuedAt;
        }
        if (entry.queuedAs === 'consolidation') {
          consolidationQueued++;
          if (
            entry.enqueuedAt !== null &&
            (oldestConsolidationAt === null || entry.enqueuedAt < oldestConsolidationAt)
          ) {
            oldestConsolidationAt = entry.enqueuedAt;
          }
        }
      }
      if (entry.pendingWakeAt !== null) pendingWakes++;
    }
    const now = this.now();
    return {
      capacity: this.maxConcurrent,
      consolidationCapacity: this.consolidationSlots,
      registered: this.entries.size,
      queued,
      running: this.runningCount,
      stalled: this.stalledCount(),
      pendingWakes,
      oldestWaitMs: oldestEnqueuedAt === null ? 0 : Math.max(0, now - oldestEnqueuedAt),
      consolidating,
      consolidationQueued,
      consolidationRunning: this.consolidationRunningCount,
      consolidationOldestWaitMs:
        oldestConsolidationAt === null ? 0 : Math.max(0, now - oldestConsolidationAt),
      decided,
      decidedQueued,
      decidedRunning: this.decidedRunningCount,
      decidedCapacity: this.decidedSlots,
      decidedLaneRunning: this.decidedLaneRunningCount,
    };
  }

  /** Exact Entry ownership only; never invokes isActive, run, abort or a join. */
  diagnosticSnapshot(tournamentId: string, selection: TournamentDiagnosticSelection = {}) {
    const tableIds = diagnosticTableIds(selection);
    const selected = new Set<Entry>();
    const current = this.entries.get(tournamentId);
    if (current) selected.add(current);
    const iterator = this.activeEntries.values();
    let scanned = 0;
    for (let i = 0; i < 32; i++) {
      const next = iterator.next();
      if (next.done) break;
      scanned++;
      if (next.value.tournamentId === tournamentId) selected.add(next.value);
    }
    const rows = [...selected].map((entry) => {
      let owner: ManagerSnapshot | null = null;
      if (entry.diagnosticOwner) {
        try {
          const candidate = entry.diagnosticOwner.snapshot({ tableIds });
          const instance = Object.getOwnPropertyDescriptor(candidate, 'instanceId');
          const generation = Object.getOwnPropertyDescriptor(candidate, 'leaseGeneration');
          const tournament = Object.getOwnPropertyDescriptor(candidate, 'tournamentId');
          if (
            instance &&
            'value' in instance &&
            instance.value === entry.diagnosticOwner.managerInstanceId &&
            generation &&
            'value' in generation &&
            generation.value === entry.diagnosticOwner.leaseGeneration &&
            tournament &&
            'value' in tournament &&
            tournament.value === tournamentId
          )
            owner = candidate;
        } catch {
          /* old ownership remains unknown; no fallback to a replacement */
        }
      }
      return Object.freeze({
        registrationId: entry.diagnosticRegistrationId,
        tournamentId: entry.tournamentId,
        managerInstanceId: entry.diagnosticOwner?.managerInstanceId ?? null,
        leaseGeneration: entry.diagnosticOwner?.leaseGeneration ?? null,
        operationId: entry.running ? entry.diagnosticOperationId : null,
        operationCorrelation: !entry.running
          ? ('not_running' as const)
          : entry.diagnosticOperationId
            ? ('observed' as const)
            : ('unavailable' as const),
        currentRegistration: entry === current,
        registered: entry.registered,
        running: entry.running,
        warned: entry.warned,
        queuedAs: entry.queuedAs,
        consolidating: entry.consolidating,
        runningLane: entry.runningLane,
        dirtyAs: entry.dirtyAs,
        queueTicket: entry.queueTicket,
        enqueuedAt: entry.enqueuedAt,
        pendingWakeAt: entry.pendingWakeAt,
        pendingWakeAs: entry.pendingWakeAs,
        abortRequested: entry.abortController?.signal.aborted ?? null,
        owner,
        ownerAvailability: owner ? ('observed' as const) : ('unavailable' as const),
      });
    });
    return Object.freeze({
      tournamentId,
      activeEntriesCount: this.activeEntries.size,
      activeEntriesScanned: scanned,
      activeScanTruncated: this.activeEntries.size > scanned,
      matchingEntriesCountLowerBound: rows.length,
      entries: Object.freeze(rows),
      missingMeans: 'unknown' as const,
    });
  }

  /** Test/process teardown only. Manager teardown uses its unregister closure. */
  stop(): void {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.metricsTimer = null;
    this.wakeTimer = null;
    this.wakeTimerDueAt = null;
    for (const entry of this.entries.values()) {
      entry.registered = false;
      entry.abortController?.abort();
    }
    this.entries.clear();
    this.consolidationQueue.length = 0;
    this.decidedQueue.length = 0;
    this.urgentQueue.length = 0;
    this.routineQueue.length = 0;
    this.activeTournamentIds.clear();
    this.activeEntries.clear();
    this.runningCount = 0;
    this.consolidationRunningCount = 0;
    this.decidedLaneRunningCount = 0;
    this.decidedRunningCount = 0;
    this.allSlotsStalledReported = false;
    this.refreshMetrics(true);
  }

  private remove(entry: Entry): void {
    entry.registered = false;
    entry.consolidating = false;
    entry.decided = false;
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
    // The wake timer may still be armed for this entry's deadline. It fires,
    // finds nothing due, and re-arms from a scan; cheaper than scanning here
    // for every one of a lease storm's hundreds of removals.
    this.refreshMetrics();
  }

  private enqueue(entry: Entry, kind: QueueKind, pumpNow = true): void {
    if (!entry.registered || entry.isActive?.() === false) return;
    kind = this.laneFor(entry, kind);
    if (entry.running) {
      entry.dirtyAs = strongerQueueKind(entry.dirtyAs, kind);
      return;
    }
    if (entry.queuedAs) {
      if (QUEUE_KIND_RANK[kind] > QUEUE_KIND_RANK[entry.queuedAs]) {
        // Upgrade without giving anything up: a place in the stronger lane
        // under the same ticket, and the weaker place stays live. Whichever
        // the scheduler reaches first serves it; logical queue depth remains
        // one.
        entry.queuedAs = kind;
        this.queueFor(kind).push({ entry, ticket: entry.queueTicket });
        this.refreshMetrics();
        if (pumpNow) this.pump();
      }
      return;
    }
    entry.queuedAs = kind;
    entry.queueTicket++;
    entry.enqueuedAt = this.now();
    this.queueFor(kind).push({
      entry,
      ticket: entry.queueTicket,
    });
    this.refreshMetrics();
    if (pumpNow) this.pump();
  }

  /** Re-arm from a full scan; used only when the armed deadline is unknown or spent. */
  private armWakeTimer(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
      this.wakeTimerDueAt = null;
    }
    let earliest: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.pendingWakeAt !== null && (earliest === null || entry.pendingWakeAt < earliest)) {
        earliest = entry.pendingWakeAt;
      }
    }
    if (earliest === null) return;
    this.armWakeTimerAt(earliest);
  }

  private armWakeTimerAt(dueAt: number): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.wakeTimerDueAt = dueAt;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.wakeTimerDueAt = null;
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
        //
        // The batch counts as a pump pass (2026-09-11). enqueue() asks each
        // entry isActive(), and a manager whose lease proof has lapsed answers
        // by unregistering, whose closure pumps. Outside a pass that pump ran
        // right there, mid-batch, and dispatched whatever was queued so far: a
        // routine sweep took the last slot before an urgent bust sweep later
        // in the same batch had even been enqueued. Such a pump is now folded
        // into the one below, exactly as it is inside pump() itself.
        this.pumping = true;
        try {
          due
            .sort((a, b) => a.dueAt - b.dueAt || a.order - b.order)
            .forEach(({ entry, kind }) => this.enqueue(entry, kind, false));
        } finally {
          this.pumping = false;
        }
        this.pump();
        this.armWakeTimer();
        this.refreshMetrics();
      },
      Math.max(0, dueAt - this.now())
    );
    this.wakeTimer.unref?.();
  }

  private shiftValid(queue: QueuedPlace[]): Entry | null {
    // A stopped/replaced manager's old promise can still be unwinding. Scan
    // each queued place at most once and rotate a replacement behind it;
    // this prevents two generations of one tournament from colliding while
    // still allowing unrelated tournaments to use the other slots.
    const candidates = queue.length;
    for (let scanned = 0; scanned < candidates; scanned++) {
      const place = queue.shift()!;
      const entry = place.entry;
      if (
        entry.registered &&
        this.entries.get(entry.tournamentId) === entry &&
        entry.queuedAs !== null &&
        place.ticket === entry.queueTicket
      ) {
        if (this.activeTournamentIds.has(entry.tournamentId)) {
          queue.push(place);
          continue;
        }
        return entry;
      }
    }
    return null;
  }

  /** The consolidation lane, served first and only from consolidation slots. */
  private nextConsolidation(): Entry | null {
    return this.shiftValid(this.consolidationQueue);
  }

  /**
   * General slots. Urgent and routine keep their burst rule exactly; a
   * consolidation place is taken here only when neither lane has anything.
   */
  private next(): Entry | null {
    // A decided game first, but never on the last general slot: live work
    // always keeps one (DECIDED_LANE_LEAVES_LIVE_SLOTS).
    if (
      this.decidedQueue.length > 0 &&
      this.decidedRunningCount < this.maxConcurrent - DECIDED_LANE_LEAVES_LIVE_SLOTS
    ) {
      const decided = this.shiftValid(this.decidedQueue);
      if (decided) return decided;
    }
    const preferUrgent =
      this.urgentQueue.length > 0 &&
      (this.urgentRunStreak < this.urgentBurst || this.routineQueue.length === 0);
    if (preferUrgent) {
      const urgent = this.shiftValid(this.urgentQueue);
      if (urgent) {
        this.urgentRunStreak++;
        return urgent;
      }
    }
    const routine = this.shiftValid(this.routineQueue);
    if (routine) {
      this.urgentRunStreak = 0;
      return routine;
    }
    const urgent = this.shiftValid(this.urgentQueue);
    if (urgent) {
      this.urgentRunStreak++;
      return urgent;
    }
    // No live work is waiting: a decided game may use the last slot too.
    return this.shiftValid(this.decidedQueue) ?? this.shiftValid(this.consolidationQueue);
  }

  /**
   * pump() is never re-entered (2026-09-10). Everything it calls back into may
   * ask for another pump while this one is still on the stack: isActive() is a
   * manager's lifecycleIsCurrent(), which, once the manager's lease proof has
   * expired, fences its tables, applies the stop fence and unregisters - and
   * the unregister closure pumps. Recursing there nested one pump per dead
   * manager. In a lease storm hundreds of queued managers expire together, and
   * at 20:13 and 20:57 that day ~350 of them ran the stack out: RangeError from
   * inside a promise reaction, an unhandled rejection, a fatal restart. A pump
   * requested while one is running is folded into the running one, which
   * re-reads capacity and both queues on every turn anyway, so the walk over
   * any number of dead managers is flat.
   */
  private pumping = false;
  private pumpRequestedWhilePumping = false;

  private pump(): void {
    if (this.pumping) {
      this.pumpRequestedWhilePumping = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpRequestedWhilePumping = false;
        while (this.consolidationRunningCount < this.consolidationCapacityNow()) {
          const entry = this.nextConsolidation();
          if (!entry) break;
          entry.queuedAs = null;
          entry.enqueuedAt = null;
          if (entry.isActive?.() === false) continue;
          this.dispatch(entry, 'consolidation');
        }
        while (this.decidedLaneRunningCount < this.decidedCapacityNow()) {
          const entry = this.shiftValid(this.decidedQueue);
          if (!entry) break;
          entry.queuedAs = null;
          entry.enqueuedAt = null;
          if (entry.isActive?.() === false) continue;
          this.dispatch(entry, 'decided');
        }
        while (this.generalRunningCount() < this.capacityNow()) {
          const entry = this.next();
          if (!entry) break;
          entry.queuedAs = null;
          entry.enqueuedAt = null;
          if (entry.isActive?.() === false) continue;
          this.dispatch(entry, 'general');
        }
      } while (this.pumpRequestedWhilePumping);
    } finally {
      this.pumping = false;
    }
    this.refreshMetrics();
  }

  private dispatch(entry: Entry, lane: SlotLane): void {
    entry.running = true;
    entry.runningLane = lane;
    if (lane === 'consolidation') this.consolidationRunningCount++;
    if (lane === 'decided') this.decidedLaneRunningCount++;
    entry.runningDecided = lane === 'general' && entry.decided;
    if (entry.runningDecided) this.decidedRunningCount++;
    entry.diagnosticOperationId = null;
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
      if (entry.runningLane === 'consolidation') {
        this.consolidationRunningCount = Math.max(0, this.consolidationRunningCount - 1);
      }
      if (entry.runningLane === 'decided') {
        this.decidedLaneRunningCount = Math.max(0, this.decidedLaneRunningCount - 1);
      }
      if (entry.runningDecided) {
        this.decidedRunningCount = Math.max(0, this.decidedRunningCount - 1);
        entry.runningDecided = false;
      }
      entry.runningLane = null;
      entry.diagnosticOperationId = null;
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
        // The stalled promise keeps its slot; a compensating slot opens beside
        // it (see capacityNow), so the queue keeps moving on the remaining
        // capacity instead of shrinking to whatever the stalls left.
        this.pump();
        this.refreshMetrics(true);
        const snapshot = this.snapshot();
        if (
          snapshot.running - snapshot.consolidationRunning - snapshot.decidedLaneRunning >=
            snapshot.capacity &&
          this.stalledCount('general') >= snapshot.capacity &&
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
      .then(() => {
        // The original value still flows into the same assimilation/finish chain.
        const physical = entry.run(entry.abortController!.signal);
        try {
          entry.diagnosticOperationId = diagnosticUuid(
            entry.diagnosticOwner?.operationIdFor(physical)
          );
        } catch {
          entry.diagnosticOperationId = null;
        }
        return physical;
      })
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

  /**
   * Gauges refresh at most four times a second from event paths; the one
   * second timer always refreshes. snapshot() walks every entry, and it was
   * being paid on every wake, enqueue, dispatch and finish of a 1,600-entry
   * scheduler (2026-09-16).
   */
  private refreshMetrics(force = false): void {
    const at = this.now();
    if (!force && at - this.lastMetricsRefreshAt < 250) return;
    this.lastMetricsRefreshAt = at;
    const snapshot = this.snapshot();
    registeredGauge.set(snapshot.registered);
    queueDepthGauge.set(snapshot.queued);
    consolidationQueueDepthGauge.set(snapshot.consolidationQueued);
    consolidatingGauge.set(snapshot.consolidating);
    consolidationOldestWaitGauge.set(snapshot.consolidationOldestWaitMs);
    decidedQueueDepthGauge.set(snapshot.decidedQueued);
    slotsInflightGauge.set(snapshot.running);
    stalledSlotsGauge.set(snapshot.stalled);
    oldestWaitGauge.set(snapshot.oldestWaitMs);
  }
}

/** The only live scheduler in this Node process. */
export const tournamentEliminationScheduler = new TournamentEliminationScheduler();
