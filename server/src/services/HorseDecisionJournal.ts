import { runtimeHorseJournalArchiveOptions } from './horseDecisionJournal/config.js';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { resolveReleaseIdentity } from '../releaseIdentity.js';
import { noteFire } from '../engine/BrainTelemetry.js';
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

export interface HorseJournalWorker {
  postMessage(
    message:
      | { type: 'APPEND'; records: HorseJournalRecord[] }
      | { type: 'STATS' }
      | { type: 'STOP' }
  ): void;
  on(event: string, callback: (message: any) => void): unknown;
  terminate(): Promise<number>;
  unref?(): void;
}

/** Finite terminal reasons. Writer reasons are the store's named refusals;
 * the rest name which publisher fence gave up. No paths, SQL or payloads. */
export const HORSE_JOURNAL_WRITER_REASONS = [
  'archive_bytes',
  'archive_segments',
  'archive_catalog_capacity',
  'archive_storage_capacity',
] as const;
export type HorseJournalFailureReason =
  | (typeof HORSE_JOURNAL_WRITER_REASONS)[number]
  | 'writer_unavailable'
  | 'ack_mismatch'
  | 'retry_exhausted'
  | 'restart_unavailable'
  | 'restart_failed'
  | 'termination_unverified'
  | 'shutdown_timeout'
  | 'start_failed';

/** Aggregate-only /health section. Catalog figures are the writer's last STATS
 * reply, never a wait on the worker; `statsAgeMs` says how old they are. */
export interface HorseJournalHealth {
  mode: 'starting' | 'ready' | 'recovering' | 'failed' | 'stopped' | 'unavailable';
  lastFailureReason: HorseJournalFailureReason | null;
  queued: number;
  appliedMaxCatalogBytes: number | null;
  maxCatalogBytes: number | null;
  catalogBytes: number | null;
  pendingSegments: number | null;
  records: number | null;
  maxRecords: number | null;
  maxRowid: number | null;
  statsAgeMs: number | null;
}
const EMPTY_HEALTH: Omit<HorseJournalHealth, 'mode' | 'lastFailureReason' | 'queued'> = {
  appliedMaxCatalogBytes: null,
  maxCatalogBytes: null,
  catalogBytes: null,
  pendingSegments: null,
  records: null,
  maxRecords: null,
  maxRowid: null,
  statsAgeMs: null,
};
const HEALTH_STATS_FIELDS = [
  'appliedMaxCatalogBytes',
  'maxCatalogBytes',
  'catalogBytes',
  'pendingSegments',
  'records',
  'maxRecords',
  'maxRowid',
] as const;

/** Enqueue is not a durable acknowledgement. Only the private writer's exact
 * fsynced commit ACK retires a record. Missing ACK or capacity produces a gap;
 * it never blocks gameplay, invents an empty journal or claims full coverage. */
export class HorseDecisionJournalPublisher {
  private readonly queue: HorseJournalRecord[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private mode: 'starting' | 'ready' | 'recovering' | 'failed' | 'stopped' = 'starting';
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
  private stats: Pick<HorseJournalHealth, (typeof HEALTH_STATS_FIELDS)[number]> | null = null;
  private statsAt: number | null = null;
  private statsRequestedAt: number | null = null;
  constructor(
    worker: HorseJournalWorker,
    private readonly note: (key: string) => void = noteFire,
    private readonly options: { restart?: () => HorseJournalWorker; now?: () => number } = {}
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
  private count(suffix: string): void {
    try {
      this.note(`phase15_journal_${suffix}`);
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
    this.count('unavailable');
    // Exactly one line per publisher lifetime. Until now a terminal writer
    // failure only bumped a counter, so capture stopped with nothing in the
    // log to say why until the next restart. Reason and mode only.
    console.warn(`[HorseDecisionJournal] capture stopped mode=failed reason=${reason}`);
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
  private recover(): void {
    if (this.mode === 'failed' || this.mode === 'stopped' || this.mode === 'recovering') return;
    if (!this.options.restart || this.retries >= 2) {
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
              this.fail('restart_failed');
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
    } else if (this.stopping && !this.stopSent) {
      this.stopSent = true;
      try {
        this.worker.postMessage({ type: 'STOP' });
      } catch {
        this.recover();
      }
    }
  }
  private message(message: any): void {
    if (this.mode === 'failed' || this.mode === 'stopped') return;
    if (message?.type === 'READY' && this.mode === 'starting') {
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
      !this.queue.length &&
      !this.inFlight
    ) {
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
    const writerReason = (HORSE_JOURNAL_WRITER_REASONS as readonly string[]).includes(
      message?.reason
    )
      ? (message.reason as (typeof HORSE_JOURNAL_WRITER_REASONS)[number])
      : undefined;
    if (message?.type === 'UNAVAILABLE' && writerReason) this.count(writerReason);
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
      // Conflicting ACK/schema/disk/capacity failure is not a transient retry.
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
  /** Synchronous and never waits on the writer: answers the cached figures and
   * asks a ready writer for fresh ones at most once a second, without a timer.
   * A reply that never comes leaves the age growing, which is the evidence. */
  health(): HorseJournalHealth {
    const now = this.now();
    if (
      this.mode === 'ready' &&
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
      mode: this.mode,
      lastFailureReason: this.lastFailureReason,
      queued: this.queue.length,
      ...EMPTY_HEALTH,
      ...(this.stats ?? {}),
      statsAgeMs: this.statsAt === null ? null : Math.max(0, Math.round(now - this.statsAt)),
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
      else this.dispatch();
    });
    return this.stopPromise;
  }
}

let publisher: HorseDecisionJournalPublisher | null = null;
let lifecycle: 'unstarted' | 'started' | 'start_failed' | 'stopped' = 'unstarted';
export const horseDecisionJournalConfigured = (): boolean =>
  Boolean(process.env.HORSE_DECISION_JOURNAL_DIR);
/** The /health section: null when no journal is configured, otherwise the
 * publisher's cached view. Never blocks and never touches the worker directly. */
export function horseDecisionJournalHealth(): HorseJournalHealth | null {
  if (!horseDecisionJournalConfigured()) return null;
  if (publisher) return publisher.health();
  return {
    mode:
      lifecycle === 'start_failed'
        ? 'unavailable'
        : lifecycle === 'stopped'
          ? 'stopped'
          : 'starting',
    lastFailureReason: lifecycle === 'start_failed' ? 'start_failed' : null,
    queued: 0,
    ...EMPTY_HEALTH,
  };
}
export function startHorseDecisionJournal(): void {
  if (publisher) return;
  const directory = process.env.HORSE_DECISION_JOURNAL_DIR;
  if (!directory) {
    noteFire('phase15_journal_disabled');
    return;
  }
  try {
    const entry = import.meta.url.endsWith('.ts')
      ? './horseDecisionJournal/worker.ts'
      : './horseDecisionJournal/worker.js';
    const archive = runtimeHorseJournalArchiveOptions(directory);
    const createWriter = () =>
      new Worker(new URL(entry, import.meta.url), { workerData: { directory, archive } });
    publisher = new HorseDecisionJournalPublisher(createWriter(), noteFire, {
      restart: createWriter,
    });
    lifecycle = 'started';
  } catch {
    lifecycle = 'start_failed';
    noteFire('phase15_journal_unavailable');
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
