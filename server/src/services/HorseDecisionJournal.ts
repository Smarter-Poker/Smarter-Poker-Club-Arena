import { runtimeHorseJournalArchiveOptions } from './horseDecisionJournal/config.js';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { resolveReleaseIdentity } from '../releaseIdentity.js';
// Aliased so the publisher's own counter can be named noteFire: the ledger's
// source check (HorseDataLedger.test.ts) finds its phase15_journal_* keys by it.
import { noteFire as fireBrainTelemetry } from '../engine/BrainTelemetry.js';
import {
  anchorHorseDecisionHand,
  horseHandAnchorKey,
  horseCompletedHandKey,
} from '../engine/HorseDecisionHandBinding.js';
import type {
  LiveHorseDecisionSnapshot,
  CompletedHandObservation,
} from '../engine/horseDecision/protocol.js';
import type { HorseExecutionWitness } from '../engine/HorseExecutionWitness.js';
import {
  horseDiscardHandKey,
  horseDiscardTurnKey,
  validateHorseDiscardDecision,
  type HorseDiscardDecisionCapture,
  validateHorseDiscardExecution,
  type HorseDiscardExecutionObservation,
} from './horseDecisionJournal/discard.js';
import {
  journalHash,
  horseJournalJson,
  makeHorseJournalRecord,
  type HorseJournalRecord,
  type HorseJournalKind,
} from './horseDecisionJournal/record.js';
import {
  horseLifecycleKeys,
  horseLifecycleRequestDigest,
  validateHorseRequestLifecycle,
  type HorseLifecycleRequest,
  type HorseRequestLifecycle,
} from './horseDecisionJournal/lifecycle.js';
import type { horseJournalCapacityReason } from './horseDecisionJournal/store.js';

export interface HorseJournalWorker {
  postMessage(
    message:
      | { type: 'APPEND'; records: HorseJournalRecord[] }
      | { type: 'STATS' }
      | { type: 'PROBE'; records: HorseJournalRecord[] }
      | { type: 'STOP' }
  ): void;
  on(event: string, callback: (message: any) => void): unknown;
  terminate(): Promise<number>;
  unref?(): void;
}

/** Finite named reasons. Writer reasons are the store's named quota refusals,
 * exactly the set horseJournalCapacityReason produces: they pause capture and
 * never end it. The rest name which publisher fence gave up, and those are
 * terminal. No paths, SQL or payloads. */
export const HORSE_JOURNAL_WRITER_REASONS = [
  'archive_bytes',
  'archive_segments',
  'archive_catalog_capacity',
  'archive_storage_capacity',
] as const;
export type HorseJournalCapacityReason = (typeof HORSE_JOURNAL_WRITER_REASONS)[number];
// One set, checked by the compiler: a new named refusal in the store that is
// not listed above fails the build instead of silently ending capture.
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const CAPACITY_REASONS_ARE_THE_STORE_REFUSALS: SameSet<
  HorseJournalCapacityReason,
  NonNullable<ReturnType<typeof horseJournalCapacityReason>>
> = true;
void CAPACITY_REASONS_ARE_THE_STORE_REFUSALS;
const HORSE_JOURNAL_FAILURE_REASONS = [
  ...HORSE_JOURNAL_WRITER_REASONS,
  'writer_unavailable',
  'ack_mismatch',
  'retry_exhausted',
  'restart_unavailable',
  'restart_failed',
  'termination_unverified',
  'shutdown_timeout',
  'start_failed',
] as const;
export type HorseJournalFailureReason = (typeof HORSE_JOURNAL_FAILURE_REASONS)[number];

/** A journal paused at a quota asks its writer this often whether the quota
 * has room. Fixed and bounded, and a read: a probe is not a retry of the
 * refused write and never spends the restart budget. */
export const HORSE_JOURNAL_CAPACITY_PROBE_MS = 60_000;

const HORSE_JOURNAL_MODES = [
  'starting',
  'ready',
  'paused',
  'recovering',
  'failed',
  'stopped',
  'unavailable',
  'disabled',
] as const;
export type HorseJournalMode = (typeof HORSE_JOURNAL_MODES)[number];

const HEALTH_STATS_FIELDS = [
  'appliedMaxCatalogBytes',
  'maxCatalogBytes',
  'catalogBytes',
  'pendingSegments',
  'records',
  'maxRecords',
  'maxRowid',
] as const;

/** Aggregate-only /health section. Catalog figures are the writer's last STATS
 * reply, never a wait on the worker; `statsAgeMs` says how old they are, and
 * they are kept, not cleared, when capture pauses or fails. */
export interface HorseJournalHealth {
  mode: HorseJournalMode;
  lastFailureReason: HorseJournalFailureReason | null;
  /** The quota capture is paused at; null unless paused. */
  pausedReason: HorseJournalCapacityReason | null;
  /** ISO time the current pause began; null unless paused. */
  pausedSince: string | null;
  /** ISO time capture stopped for good; null unless failed. */
  failedSince: string | null;
  queued: number;
  appliedMaxCatalogBytes: number | null;
  maxCatalogBytes: number | null;
  catalogBytes: number | null;
  pendingSegments: number | null;
  records: number | null;
  maxRecords: number | null;
  maxRowid: number | null;
  statsAgeMs: number | null;
  /** Age of this report when it is read from a thread that does not own the
   * publisher (the main thread serving /health); null when read in place. */
  reportAgeMs: number | null;
}
const EMPTY_HEALTH: Pick<HorseJournalHealth, (typeof HEALTH_STATS_FIELDS)[number] | 'statsAgeMs'> =
  {
    appliedMaxCatalogBytes: null,
    maxCatalogBytes: null,
    catalogBytes: null,
    pendingSegments: null,
    records: null,
    maxRecords: null,
    maxRowid: null,
    statsAgeMs: null,
  };
const idleHealth = (
  mode: HorseJournalMode,
  lastFailureReason: HorseJournalFailureReason | null = null
): HorseJournalHealth => ({
  mode,
  lastFailureReason,
  pausedReason: null,
  pausedSince: null,
  failedSince: null,
  queued: 0,
  ...EMPTY_HEALTH,
  reportAgeMs: null,
});
const isoTime = (ms: number | null): string | null => {
  if (ms === null || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
};

/** Enqueue is not a durable acknowledgement. Only the private writer's exact
 * fsynced commit ACK retires a record. Missing ACK or capacity produces a gap;
 * it never blocks gameplay, invents an empty journal or claims full coverage. */
export class HorseDecisionJournalPublisher {
  private readonly queue: HorseJournalRecord[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private mode: 'starting' | 'ready' | 'paused' | 'recovering' | 'failed' | 'stopped' = 'starting';
  private worker: HorseJournalWorker | null = null;
  private readonly seenWorkers = new WeakSet<HorseJournalWorker>();
  private epoch = 0;
  private retries = 0;
  private recoveryPending = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private termination: Promise<boolean> = Promise.resolve(true);
  private stopping = false;
  private stopSent = false;
  private shutdownUnverified = false;
  private inFlight = 0;
  private stopPromise?: Promise<void>;
  private stopped?: () => void;
  private readonly producerId = randomUUID();
  private readonly sourceRelease = resolveReleaseIdentity().releaseSha;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private lastProgress: number;
  private lastFailureReason: HorseJournalFailureReason | null = null;
  private pausedReason: HorseJournalCapacityReason | null = null;
  private pausedAt: number | null = null;
  private failedAt: number | null = null;
  /** Whether any writer this publisher owned ever answered READY. A publisher
   * whose writers all died before READY never started capture at all. */
  private everReady = false;
  private probeTimer?: ReturnType<typeof setInterval>;
  private stats: Pick<HorseJournalHealth, (typeof HEALTH_STATS_FIELDS)[number]> | null = null;
  private statsAt: number | null = null;
  private statsRequestedAt: number | null = null;
  constructor(
    worker: HorseJournalWorker,
    private readonly noteFire: (key: string) => void = fireBrainTelemetry,
    private readonly options: {
      restart?: () => HorseJournalWorker;
      now?: () => number;
      /** Wall clock for pausedSince/failedSince; tests pin it. */
      wallNow?: () => number;
      capacityProbeMs?: number;
      /** Told once, when capture ends without any writer ever reaching READY. */
      onStartFailed?: () => void;
    } = {}
  ) {
    this.lastProgress = this.now();
    this.attach(worker);
    this.watchdog = setInterval(() => {
      if (
        (this.mode === 'starting' || (this.mode === 'ready' && this.inFlight > 0)) &&
        this.now() - this.lastProgress > 5000
      )
        this.recover();
    }, 1000);
    this.watchdog.unref?.();
  }
  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
  private wallNow(): number {
    return this.options.wallNow?.() ?? Date.now();
  }
  private count(suffix: string): void {
    try {
      this.noteFire(`phase15_journal_${suffix}`);
    } catch {
      /* diagnostic only */
    }
  }
  private attach(worker: HorseJournalWorker): void {
    if (this.seenWorkers.has(worker)) throw Error('Horse journal writer cannot be reused');
    this.seenWorkers.add(worker);
    this.worker = worker;
    this.mode = 'starting';
    this.stopSent = false;
    this.lastProgress = this.now();
    const epoch = ++this.epoch;
    const current = () => this.worker === worker && this.epoch === epoch;
    worker.on('message', (message) => {
      if (current()) this.message(message);
    });
    worker.on('error', () => {
      if (current()) this.recover();
    });
    worker.on('exit', () => {
      if (!current() || this.mode === 'stopped') return;
      this.recover();
    });
    worker.unref?.();
  }
  /** Never start a replacement while the retired writer may still be alive.
   * Only termination confirmation can release this bounded ownership fence. */
  private retireWriter(): Promise<boolean> {
    const worker = this.worker;
    if (!worker) return this.termination;
    this.worker = null;
    this.epoch++;
    this.termination = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 1000);
      const finish = (confirmed: boolean) => {
        clearTimeout(timer);
        resolve(confirmed);
      };
      try {
        void worker
          .terminate()
          .then(() => finish(true))
          .catch(() => finish(false));
      } catch {
        finish(false);
      }
    });
    return this.termination;
  }
  private noteShutdownGap(): void {
    if (!this.shutdownUnverified) {
      this.shutdownUnverified = true;
      this.count('shutdown_unverified');
    }
  }
  private fail(reason: HorseJournalFailureReason): void {
    if (this.mode === 'failed' || this.mode === 'stopped') return;
    this.mode = 'failed';
    this.lastFailureReason = reason;
    this.failedAt = this.wallNow();
    this.endPause();
    this.count('unavailable');
    if (reason === 'start_failed') this.count('start_failed');
    // Exactly one line per publisher lifetime. Until now a terminal writer
    // failure only bumped a counter, so capture stopped with nothing in the
    // log to say why until the next restart. Reason and mode only.
    console.warn(
      `[HorseDecisionJournal] capture stopped mode=${this.reportedMode()} reason=${reason}`
    );
    if (reason === 'start_failed') {
      try {
        this.options.onStartFailed?.();
      } catch {
        /* the lifecycle note never interrupts the failure path */
      }
    }
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    void this.retireWriter()
      .then((confirmed) => {
        if (!confirmed) this.count('termination_unverified');
        if (this.stopping) {
          if (this.queue.length || !confirmed) this.noteShutdownGap();
          this.stopped?.();
        }
      })
      .catch(() => {
        this.count('termination_unverified');
        if (this.stopping) {
          this.noteShutdownGap();
          this.stopped?.();
        }
      });
  }
  /** A quota refusal of an in-flight APPEND. The writer refused before it
   * committed anything, so the batch is still unacknowledged: keep it, keep the
   * writer, stop dispatching and ask on a fixed schedule whether there is room.
   * The same immutable records are replayed on resume; the store answers a
   * record it already holds as `replayed`, so nothing is written twice. */
  private pause(reason: HorseJournalCapacityReason): void {
    this.mode = 'paused';
    this.inFlight = 0;
    this.pausedReason = reason;
    this.pausedAt = this.wallNow();
    this.count('capacity_paused');
    // One line on entering, one on resuming. Reason, mode and a count only.
    console.warn(
      `[HorseDecisionJournal] capture paused mode=paused reason=${reason} queued=${this.queue.length}`
    );
    // Refused while draining for shutdown: there is no minute to wait. Stop the
    // writer now; the STOPPED reply names the uncaptured queue as a gap.
    if (this.stopping) {
      this.sendStop();
      return;
    }
    clearInterval(this.probeTimer);
    this.probeTimer = setInterval(
      () => this.probe(),
      this.options.capacityProbeMs ?? HORSE_JOURNAL_CAPACITY_PROBE_MS
    );
    this.probeTimer.unref?.();
  }
  private endPause(): void {
    clearInterval(this.probeTimer);
    this.probeTimer = undefined;
    this.pausedReason = null;
    this.pausedAt = null;
  }
  /** Ask, read-only, whether the batch that would be dispatched next fits. */
  private probe(): void {
    if (this.mode !== 'paused' || !this.worker || this.stopping || !this.queue.length) return;
    try {
      this.worker.postMessage({ type: 'PROBE', records: this.queue.slice(0, 16) });
    } catch {
      this.recover();
    }
  }
  private capacityAnswer(message: any): void {
    if (this.stopping) return;
    if (message?.room === true) {
      const reason = this.pausedReason;
      this.endPause();
      this.mode = 'ready';
      this.lastProgress = this.now();
      this.count('capacity_resumed');
      console.warn(
        `[HorseDecisionJournal] capture resumed mode=ready after=${reason} queued=${this.queue.length}`
      );
      this.dispatch();
      return;
    }
    // Still full; a different named quota may now be the binding one.
    if ((HORSE_JOURNAL_WRITER_REASONS as readonly string[]).includes(message?.reason))
      this.pausedReason = message.reason as HorseJournalCapacityReason;
  }
  private recover(): void {
    if (this.mode === 'failed' || this.mode === 'stopped' || this.mode === 'recovering') return;
    // A writer that died while paused is restarted like any other; a replacement
    // that meets the same quota pauses again from its first append.
    this.endPause();
    if (!this.options.restart || this.retries >= 2) {
      /* A WRITER THAT NEVER SAID READY NEVER STARTED (2026-09-26). A module
         that cannot load is reported by `new Worker()` ASYNCHRONOUSLY, as an
         'error' then an 'exit' event - never as a throw - so the try/catch in
         startHorseDecisionJournal cannot see it, and the journal used to end
         this path as `retry_exhausted` after announcing itself started. No
         writer ever opened the store, so nothing was retried: capture never
         began. Name it for what it is, the same `start_failed` a synchronous
         construction failure reports. */
      if (!this.everReady) {
        this.fail('start_failed');
        return;
      }
      if (this.options.restart) this.count('retry_exhausted');
      this.fail(this.options.restart ? 'retry_exhausted' : 'restart_unavailable');
      return;
    }
    this.mode = 'recovering';
    this.retries++;
    this.recoveryPending = true;
    this.count('retry_scheduled');
    // Keep immutable queue, producer UUID, sequence and entire-record digests.
    // A lost ACK replays the same bytes; it never regenerates an event identity.
    this.inFlight = 0;
    void this.retireWriter()
      .then((confirmed) => {
        if (this.mode !== 'recovering') return;
        if (!confirmed) {
          this.fail('termination_unverified');
          return;
        }
        this.retryTimer = setTimeout(
          () => {
            if (this.mode !== 'recovering') return;
            try {
              const replacement = this.options.restart!();
              this.count('retry_started');
              this.attach(replacement);
            } catch {
              this.fail(this.everReady ? 'restart_failed' : 'start_failed');
            }
          },
          this.retries === 1 ? 250 : 1000
        );
        this.retryTimer.unref?.();
      })
      .catch(() => this.fail('termination_unverified'));
  }
  record(kind: HorseJournalKind, handKey: string | null, turnKey: string, payload: unknown): void {
    if (this.mode === 'failed' || this.mode === 'stopped' || this.stopping || !handKey) {
      this.count('capture_unavailable');
      return;
    }
    // Paused at a quota: counted apart from a failed journal, and still queued
    // within the same bounds so the resumed writer receives it.
    if (this.mode === 'paused') this.count('capture_paused_capacity');
    try {
      const record = makeHorseJournalRecord(
        {
          producerId: this.producerId,
          sequence: ++this.sequence,
          sourceRelease: this.sourceRelease,
          atMs: Date.now(),
          kind,
          handKey: journalHash(handKey),
          turnKey: journalHash(turnKey),
        },
        payload
      );
      // Preflight the same complete envelope bound as the durable writer. A
      // too-large record is a capture gap; it must not poison later writes.
      const bytes = Buffer.byteLength(horseJournalJson(record));
      if (this.queue.length >= 64 || this.queuedBytes + bytes > 4 * 1024 * 1024) {
        this.count('queue_capacity');
        return;
      }
      this.queue.push(record);
      this.queuedBytes += bytes;
      this.count('enqueued');
      this.dispatch();
    } catch {
      this.count('capture_unavailable');
    }
  }
  requestLifecycle(request: HorseLifecycleRequest, lifecycle: HorseRequestLifecycle): void {
    validateHorseRequestLifecycle(lifecycle);
    if (lifecycle.requestDigest !== horseLifecycleRequestDigest(request))
      throw Error('Horse lifecycle request digest mismatch');
    const keys = horseLifecycleKeys(request);
    this.record('request_lifecycle', keys.hand, keys.turn, lifecycle);
  }
  private dispatch(): void {
    if (this.mode !== 'ready' || !this.worker || this.inFlight) return;
    if (this.queue.length) {
      this.inFlight = Math.min(16, this.queue.length);
      this.lastProgress = this.now();
      try {
        this.worker.postMessage({ type: 'APPEND', records: this.queue.slice(0, this.inFlight) });
      } catch {
        this.recover();
      }
    } else if (this.stopping && !this.stopSent) this.sendStop();
  }
  private sendStop(): void {
    if (!this.worker || this.stopSent) return;
    this.stopSent = true;
    clearInterval(this.probeTimer);
    try {
      this.worker.postMessage({ type: 'STOP' });
    } catch {
      this.recover();
    }
  }
  private message(message: any): void {
    if (this.mode === 'failed' || this.mode === 'stopped') return;
    if (message?.type === 'READY' && this.mode === 'starting') {
      this.everReady = true;
      this.mode = 'ready';
      this.lastProgress = this.now();
      this.dispatch();
      return;
    }
    if (message?.type === 'RETRYABLE' && (this.mode === 'starting' || this.inFlight > 0)) {
      this.recover();
      return;
    }
    if (
      message?.type === 'STOPPED' &&
      this.stopping &&
      this.stopSent &&
      !this.inFlight &&
      (!this.queue.length || this.mode === 'paused')
    ) {
      // Stopped while paused at a quota: the queue was never captured. Say so.
      if (this.queue.length) this.noteShutdownGap();
      this.endPause();
      this.mode = 'stopped';
      clearInterval(this.watchdog);
      clearTimeout(this.retryTimer);
      this.stopped?.();
      return;
    }
    if (message?.type === 'STATS') {
      this.receiveStats(message.stats);
      return;
    }
    if (message?.type === 'CAPACITY') {
      // A probe answer is read-only evidence, never an acknowledgement.
      if (this.mode === 'paused') this.capacityAnswer(message);
      return;
    }
    const writerReason = (HORSE_JOURNAL_WRITER_REASONS as readonly string[]).includes(
      message?.reason
    )
      ? (message.reason as (typeof HORSE_JOURNAL_WRITER_REASONS)[number])
      : undefined;
    if (message?.type === 'UNAVAILABLE' && writerReason) this.count(writerReason);
    // 2026-09-18 (catalog ceiling) and 2026-09-25 19:34:05 UTC (500,000
    // segments): a quota refusal used to fall through to fail() below and end
    // capture for the life of the process. A quota is a condition: pause.
    // A capacity report from a writer that never became ready (it could not
    // open, and has closed its port) has no writer to probe: that stays terminal.
    if (
      message?.type === 'UNAVAILABLE' &&
      writerReason &&
      this.mode === 'ready' &&
      this.inFlight > 0
    ) {
      this.pause(writerReason);
      return;
    }
    if (
      message?.type !== 'ACK' ||
      !this.inFlight ||
      !Array.isArray(message.receipts) ||
      message.receipts.length !== this.inFlight ||
      message.receipts.some(
        (receipt: any, index: number) =>
          !receipt ||
          receipt.eventId !== this.queue[index]?.eventId ||
          receipt.sha256 !== this.queue[index]?.sha256 ||
          !['recorded', 'replayed'].includes(receipt.status)
      )
    ) {
      // A conflicting ACK, schema or integrity refusal is not a transient retry.
      this.fail(
        message?.type === 'UNAVAILABLE'
          ? (writerReason ?? 'writer_unavailable')
          : message?.type === 'ACK'
            ? 'ack_mismatch'
            : 'writer_unavailable'
      );
      return;
    }
    for (let i = 0; i < this.inFlight; i++) {
      const head = this.queue.shift()!;
      this.queuedBytes -= Buffer.byteLength(JSON.stringify(head));
      this.count(message.receipts[i].status);
    }
    if (this.recoveryPending) {
      this.recoveryPending = false;
      this.count('retry_recovered');
    }
    // The finite budget belongs to unacknowledged work, not the publisher's
    // lifetime. Only this complete, identity-checked durable ACK proves progress;
    // READY, retired-worker messages and malformed receipts cannot renew it.
    this.retries = 0;
    this.inFlight = 0;
    this.lastProgress = this.now();
    this.dispatch();
  }
  private receiveStats(stats: unknown): void {
    this.statsRequestedAt = null;
    const archive = (stats as { archive?: unknown } | null)?.archive as
      | Record<string, unknown>
      | null
      | undefined;
    if (!archive || typeof archive !== 'object') return;
    const number = (key: string): number | null =>
      typeof archive[key] === 'number' && Number.isSafeInteger(archive[key])
        ? (archive[key] as number)
        : null;
    this.stats = {
      appliedMaxCatalogBytes: number('appliedMaxCatalogBytes'),
      maxCatalogBytes: number('maxCatalogBytes'),
      catalogBytes: number('catalogBytes'),
      pendingSegments: number('pendingSegments'),
      records: number('records'),
      maxRecords: number('maxRecords'),
      maxRowid: number('maxRowid'),
    };
    this.statsAt = this.now();
  }
  /** A journal that never started is `unavailable`, exactly as a writer that
   * could not even be constructed is; `failed` is a journal that once ran. */
  private reportedMode(): HorseJournalMode {
    return this.mode === 'failed' && this.lastFailureReason === 'start_failed'
      ? 'unavailable'
      : this.mode;
  }
  /** Synchronous and never waits on the writer: answers the cached figures and
   * asks a ready writer for fresh ones at most once a second, without a timer.
   * A reply that never comes leaves the age growing, which is the evidence. */
  health(): HorseJournalHealth {
    const now = this.now();
    if (
      (this.mode === 'ready' || this.mode === 'paused') &&
      this.worker &&
      (this.statsRequestedAt === null || now - this.statsRequestedAt >= 1000)
    ) {
      this.statsRequestedAt = now;
      try {
        this.worker.postMessage({ type: 'STATS' });
      } catch {
        /* the watchdog and exit handler own a dead writer, not a probe */
      }
    }
    return {
      mode: this.reportedMode(),
      lastFailureReason: this.lastFailureReason,
      pausedReason: this.pausedReason,
      pausedSince: isoTime(this.pausedAt),
      failedSince: this.mode === 'failed' ? isoTime(this.failedAt) : null,
      queued: this.queue.length,
      ...EMPTY_HEALTH,
      ...(this.stats ?? {}),
      statsAgeMs: this.statsAt === null ? null : Math.max(0, Math.round(now - this.statsAt)),
      reportAgeMs: null,
    };
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.noteShutdownGap();
        this.fail('shutdown_timeout');
        finish();
      }, 5000);
      const finish = () => {
        clearTimeout(timer);
        clearInterval(this.watchdog);
        clearTimeout(this.retryTimer);
        clearInterval(this.probeTimer);
        resolve();
      };
      this.stopped = finish;
      if (this.mode === 'failed') {
        void this.termination
          .then((confirmed) => {
            if (this.queue.length || !confirmed) this.noteShutdownGap();
            finish();
          })
          .catch(() => {
            this.noteShutdownGap();
            finish();
          });
      } else if (this.mode === 'stopped') finish();
      else if (this.mode === 'paused') this.sendStop();
      else this.dispatch();
    });
    return this.stopPromise;
  }
}

let publisher: HorseDecisionJournalPublisher | null = null;
let lifecycle: 'unstarted' | 'started' | 'start_failed' | 'stopped' = 'unstarted';
export const horseDecisionJournalConfigured = (): boolean =>
  Boolean(process.env.HORSE_DECISION_JOURNAL_DIR);

/** Where the report comes from. The publisher lives in the Horse decision
 * worker thread (workerRuntime.ts starts it). /health is served by the main
 * thread, whose copy of this module never has a publisher: until 2026-09-26 it
 * therefore answered `starting` with every figure null whatever the journal
 * was doing, and did so for seven hours after capture stopped on 2026-09-25.
 * The worker's STATUS reply now carries its report (client.ts relays it here). */
let relayed: { health: HorseJournalHealth; at: number } | null = null;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Rebuild a report that crossed the thread boundary from its finite field
 * set. Anything else in it is dropped; a malformed report is not shown. */
function horseJournalHealthFromReport(value: unknown): HorseJournalHealth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!(HORSE_JOURNAL_MODES as readonly unknown[]).includes(v.mode)) return null;
  const count = (x: unknown): number | null =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null;
  const time = (x: unknown): string | null =>
    typeof x === 'string' && ISO_TIME.test(x) ? x : null;
  const health: HorseJournalHealth = {
    mode: v.mode as HorseJournalMode,
    lastFailureReason: (HORSE_JOURNAL_FAILURE_REASONS as readonly unknown[]).includes(
      v.lastFailureReason
    )
      ? (v.lastFailureReason as HorseJournalFailureReason)
      : null,
    pausedReason: (HORSE_JOURNAL_WRITER_REASONS as readonly unknown[]).includes(v.pausedReason)
      ? (v.pausedReason as HorseJournalCapacityReason)
      : null,
    pausedSince: time(v.pausedSince),
    failedSince: time(v.failedSince),
    queued: count(v.queued) ?? 0,
    ...EMPTY_HEALTH,
    statsAgeMs: count(v.statsAgeMs),
    reportAgeMs: null,
  };
  for (const key of HEALTH_STATS_FIELDS) health[key] = count(v[key]);
  return health;
}
/** Called on the thread that serves /health with the owning thread's report. */
export function relayHorseDecisionJournalHealth(report: unknown): void {
  const health = horseJournalHealthFromReport(report);
  if (health) relayed = { health, at: performance.now() };
}
/** The /health section, in every state: `disabled` without a journal
 * directory, the publisher's own view on the thread that owns it, otherwise
 * the owning thread's last report with its age. Never blocks and never touches
 * a worker directly. */
export function horseDecisionJournalHealth(): HorseJournalHealth {
  if (!horseDecisionJournalConfigured()) return idleHealth('disabled');
  if (publisher) return publisher.health();
  if (lifecycle === 'start_failed') return idleHealth('unavailable', 'start_failed');
  if (lifecycle === 'stopped') return idleHealth('stopped');
  if (relayed) {
    const age = Math.max(0, Math.round(performance.now() - relayed.at));
    const report = relayed.health;
    return {
      ...report,
      statsAgeMs: report.statsAgeMs === null ? null : report.statsAgeMs + age,
      reportAgeMs: age,
    };
  }
  return idleHealth('starting');
}
export function startHorseDecisionJournal(): void {
  if (publisher) return;
  const directory = process.env.HORSE_DECISION_JOURNAL_DIR;
  if (!directory) {
    fireBrainTelemetry('phase15_journal_disabled');
    return;
  }
  try {
    const entry = import.meta.url.endsWith('.ts')
      ? './horseDecisionJournal/worker.ts'
      : './horseDecisionJournal/worker.js';
    const archive = runtimeHorseJournalArchiveOptions(directory);
    const createWriter = () =>
      new Worker(new URL(entry, import.meta.url), { workerData: { directory, archive } });
    // `lifecycle` says only that construction did not throw. A writer module
    // that cannot load fails later, as an event; the publisher reports that as
    // start_failed and moves the lifecycle with it.
    const owned: { publisher: HorseDecisionJournalPublisher | null } = { publisher: null };
    owned.publisher = new HorseDecisionJournalPublisher(createWriter(), fireBrainTelemetry, {
      restart: createWriter,
      onStartFailed: () => {
        if (publisher === owned.publisher && lifecycle === 'started') lifecycle = 'start_failed';
      },
    });
    publisher = owned.publisher;
    lifecycle = 'started';
  } catch {
    lifecycle = 'start_failed';
    fireBrainTelemetry('phase15_journal_unavailable');
  }
}
export async function stopHorseDecisionJournal(): Promise<void> {
  const owned = publisher;
  publisher = null;
  if (owned) lifecycle = 'stopped';
  await owned?.stop();
}
const turnKey = (x: {
  generation: number;
  fence: string;
  requestId: number;
  decisionKey: string;
  decisionTimeMs: number;
}) => JSON.stringify([x.generation, x.fence, x.requestId, x.decisionKey, x.decisionTimeMs]);
export function journalHorseDecision(
  snapshot: LiveHorseDecisionSnapshot & { requestId: number },
  payload: unknown
): void {
  if (!publisher) return;
  const anchor = anchorHorseDecisionHand(snapshot);
  publisher.record(
    'decision',
    anchor.status === 'anchored' ? horseHandAnchorKey(anchor) : null,
    turnKey(snapshot),
    payload
  );
}
export function journalHorseRequestLifecycle(
  request: HorseLifecycleRequest,
  lifecycle: HorseRequestLifecycle
): void {
  publisher?.requestLifecycle(request, lifecycle);
}
export function journalHorseExecution(witness: HorseExecutionWitness): void {
  if (!publisher) return;
  publisher.record(
    'execution',
    witness.handAnchor.status === 'anchored' ? horseHandAnchorKey(witness.handAnchor) : null,
    turnKey(witness.identity),
    witness
  );
}
export function journalHorseAcceptedHand(hand: CompletedHandObservation): void {
  if (!publisher) return;
  const key = horseCompletedHandKey(hand);
  publisher.record('accepted_hand', key, key ?? 'unavailable', hand);
}

export function journalHorseDiscard(capture: HorseDiscardDecisionCapture): void {
  if (!publisher) return;
  // A legacy/isolated snapshot is allowed to play, but cannot manufacture a
  // durable hand association from an unverified lease or missing actor.
  validateHorseDiscardDecision(capture);
  publisher.record(
    'discard_decision',
    horseDiscardHandKey(capture.snapshot),
    horseDiscardTurnKey(capture.snapshot),
    capture
  );
}

export function journalHorseDiscardExecution(execution: HorseDiscardExecutionObservation): void {
  if (!publisher) return;
  validateHorseDiscardExecution(execution);
  publisher.record(
    'discard_execution',
    horseDiscardHandKey(execution.request),
    horseDiscardTurnKey(execution.request),
    execution
  );
}
