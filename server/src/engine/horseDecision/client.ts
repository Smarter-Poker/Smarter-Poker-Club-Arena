import { Worker } from 'node:worker_threads';

import type {
  CommitDecisionEffectsRequest,
  CompletedHandObservation,
  DecidePineappleDiscardRequest,
  DeepHorseDecisionRequest,
  DeepHorseDecisionResult,
  FastHorseDecisionRequest,
  FastHorseDecisionResult,
  HorseDecisionJobRequest,
  HorseDecisionWorkerAck,
  HorseDecisionWorkerReadiness,
  HorseDecisionWorkerReady,
  HorseDecisionWorkerRequest,
  HorseDecisionWorkerResponse,
  LiveHorseDecisionSnapshot,
  PineappleDiscardResult,
  PineappleDiscardSnapshot,
  HorseDecisionWorkerStatusResult,
} from './protocol.js';
import { horseDecisionSolverStoresAreValid } from './protocol.js';
import type { HorseMindDecisionEffect } from '../HorseMind.js';

export interface WorkerLike {
  postMessage(message: HorseDecisionWorkerRequest): void;
  on(event: 'message', listener: (message: HorseDecisionWorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
  unref?(): void;
}

export interface LiveHorseDecisionWorkerClientOptions {
  workerFactory?: () => WorkerLike;
  readyTimeoutMs?: number;
  /** Terminal deadline for one posted FIFO operation. */
  jobTimeoutMs?: number;
  /**
   * Sole-worker failure is process-fatal in production. Invoked once, after
   * pending work is rejected and termination has been initiated.
   */
  onFatal?: (error: Error) => void;
}

export type LiveHorseDecisionWorkerPhase = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface LiveHorseDecisionWorkerStatus {
  phase: LiveHorseDecisionWorkerPhase;
  startedAt: number | null;
  readyAt: number | null;
  queueDepth: number;
  activeRequestId: number | null;
  activeJobAgeMs: number | null;
  oldestQueuedAgeMs: number | null;
  lastCompletedAt: number | null;
  lastComputeMs: number | null;
  completedJobs: number;
  lastError: string | null;
  solverStores: HorseDecisionWorkerReady['solverStores'] | null;
  solverPolicyArtifact: HorseDecisionWorkerReady['solverPolicyArtifact'] | null;
  governor: HorseDecisionWorkerReady['governor'] | null;
  statusSampledAt: number | null;
}

export class HorseDecisionAbortedError extends Error {
  override readonly name = 'AbortError';

  constructor(message = 'horse decision was aborted') {
    super(message);
  }
}

/**
 * The request remained queued until its action-clock budget expired. This is
 * not an authority cancellation: the turn may still be current and must take
 * the caller's fail-safe action instead of being silently abandoned.
 */
export class HorseDecisionExpiredError extends Error {
  override readonly name = 'TimeoutError';

  constructor(message = 'horse decision expired before worker dispatch') {
    super(message);
  }
}

type JobResult =
  | FastHorseDecisionResult
  | DeepHorseDecisionResult
  | HorseDecisionWorkerAck
  | HorseDecisionWorkerStatusResult
  | PineappleDiscardResult;

interface QueuedJob {
  request: HorseDecisionJobRequest;
  expected: JobResult['type'];
  resolve: (result: JobResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
  enqueuedAt: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}

const stoppedStatus = (): LiveHorseDecisionWorkerStatus => ({
  phase: 'stopped',
  startedAt: null,
  readyAt: null,
  queueDepth: 0,
  activeRequestId: null,
  activeJobAgeMs: null,
  oldestQueuedAgeMs: null,
  lastCompletedAt: null,
  lastComputeMs: null,
  completedJobs: 0,
  lastError: null,
  solverStores: null,
  solverPolicyArtifact: null,
  governor: null,
  statusSampledAt: null,
});

function defaultWorkerFactory(): WorkerLike {
  // Production executes compiled JS; `npm run dev` executes this source via
  // tsx and workers inherit that loader. Point each runtime at an entry it can
  // actually open rather than making the development engine fail at boot.
  const entry = import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js';
  return new Worker(new URL(entry, import.meta.url)) as WorkerLike;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Main-thread owner of the process-wide single FIFO. Only one job is posted
 * at a time, so worker scheduling cannot reorder RNG-consuming decisions.
 */
export class LiveHorseDecisionWorkerClient {
  private static readonly DEFAULT_READY_TIMEOUT_MS = 90_000;
  private static readonly DEFAULT_JOB_TIMEOUT_MS = 8_000;
  private static readonly STATUS_INTERVAL_MS = 1_000;
  private readonly worker: WorkerLike;
  private readonly onFatal?: (error: Error) => void;
  private readonly jobTimeoutMs: number;
  private phase: LiveHorseDecisionWorkerPhase = 'starting';
  private readonly startedAt = Date.now();
  private readyAt: number | null = null;
  private solverStores: HorseDecisionWorkerReady['solverStores'] | null = null;
  private solverPolicyArtifact: HorseDecisionWorkerReady['solverPolicyArtifact'] | null = null;
  private governor: HorseDecisionWorkerReady['governor'] | null = null;
  private statusSampledAt: number | null = null;
  private lastError: string | null = null;
  private lastCompletedAt: number | null = null;
  private lastComputeMs: number | null = null;
  private completedJobs = 0;
  private nextRequestId = 1;
  private readonly queue: QueuedJob[] = [];
  private active: QueuedJob | null = null;
  private activeStartedAt: number | null = null;
  private dispatchHoldDepth = 0;
  /** Insert commits after work queued before the barrier, before causal successors. */
  private priorityInsertIndex: number | null = null;
  private readyPromise: Promise<HorseDecisionWorkerReadiness>;
  private resolveReady!: (readiness: HorseDecisionWorkerReadiness) => void;
  private rejectReady!: (error: Error) => void;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;
  private shutdownPosted = false;
  private shutdownAcknowledged = false;
  private startupCancellationInProgress = false;
  private fatalNotified = false;
  private terminationPromise: Promise<void> | null = null;
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: LiveHorseDecisionWorkerClientOptions = {}) {
    this.onFatal = options.onFatal;
    this.jobTimeoutMs = Math.max(
      1,
      Math.floor(options.jobTimeoutMs ?? LiveHorseDecisionWorkerClient.DEFAULT_JOB_TIMEOUT_MS)
    );
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A caller may queue immediately and await the job rather than ready().
    // Keep the readiness rejection observed without altering its semantics.
    void this.readyPromise.catch(() => undefined);
    this.worker = (options.workerFactory ?? defaultWorkerFactory)();
    this.worker.on('message', (message) => {
      if (!this.startupCancellationInProgress) this.onMessage(message);
    });
    this.worker.on('error', (error) => {
      if (!this.startupCancellationInProgress) this.fail(error);
    });
    this.worker.on('exit', (code) => {
      if (!this.shutdownAcknowledged && this.phase !== 'stopped' && this.phase !== 'failed') {
        this.fail(new Error(`live horse decision worker exited with code ${code}`));
      }
    });
    this.worker.unref?.();
    this.readyTimer = setTimeout(
      () => this.fail(new Error('live horse decision worker READY timed out')),
      options.readyTimeoutMs ?? LiveHorseDecisionWorkerClient.DEFAULT_READY_TIMEOUT_MS
    );
    this.readyTimer.unref?.();
  }

  ready(): Promise<HorseDecisionWorkerReadiness> {
    return this.readyPromise;
  }

  status(): LiveHorseDecisionWorkerStatus {
    const now = Date.now();
    const oldestQueued = this.queue.reduce<QueuedJob | null>(
      (oldest, job) =>
        job.settled || (oldest && oldest.enqueuedAt <= job.enqueuedAt) ? oldest : job,
      null
    );
    return {
      phase: this.phase,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      queueDepth: this.queue.length + (this.active ? 1 : 0),
      activeRequestId: this.active?.request.requestId ?? null,
      activeJobAgeMs:
        this.active && this.activeStartedAt !== null
          ? Math.max(0, now - this.activeStartedAt)
          : null,
      oldestQueuedAgeMs: oldestQueued ? Math.max(0, now - oldestQueued.enqueuedAt) : null,
      lastCompletedAt: this.lastCompletedAt,
      lastComputeMs: this.lastComputeMs,
      completedJobs: this.completedJobs,
      lastError: this.lastError,
      solverStores: this.solverStores ? structuredClone(this.solverStores) : null,
      solverPolicyArtifact: this.solverPolicyArtifact
        ? structuredClone(this.solverPolicyArtifact)
        : null,
      governor: this.governor ? { ...this.governor } : null,
      statusSampledAt: this.statusSampledAt,
    };
  }

  /**
   * Hold worker dispatch across one synchronous authoritative table mutation.
   * Requests may still enqueue. A priority effect commit inserted by the
   * callback is therefore guaranteed to run before TURN_CHANGE work emitted
   * synchronously by HandController.performAction.
   */
  runWithDispatchBarrier<T>(fn: () => T): T {
    const outermost = this.dispatchHoldDepth === 0;
    if (outermost) this.priorityInsertIndex = this.queue.length;
    this.dispatchHoldDepth += 1;
    try {
      return fn();
    } finally {
      this.dispatchHoldDepth = Math.max(0, this.dispatchHoldDepth - 1);
      if (outermost) {
        this.priorityInsertIndex = null;
        this.maybeDispatch();
      }
    }
  }

  decideFast(
    snapshot: LiveHorseDecisionSnapshot,
    signal?: AbortSignal
  ): Promise<FastHorseDecisionResult> {
    const request: FastHorseDecisionRequest = {
      ...snapshot,
      type: 'DECIDE_FAST',
      requestId: this.nextRequestId++,
    };
    return this.enqueue<FastHorseDecisionResult>(request, 'FAST_RESULT', signal);
  }

  decideDeep(
    snapshot: LiveHorseDecisionSnapshot & { rngBefore: number; deepEquity: number },
    signal?: AbortSignal
  ): Promise<DeepHorseDecisionResult> {
    const request: DeepHorseDecisionRequest = {
      ...snapshot,
      type: 'DECIDE_DEEP',
      requestId: this.nextRequestId++,
    };
    return this.enqueue<DeepHorseDecisionResult>(request, 'DEEP_RESULT', signal);
  }

  observeCompletedHand(
    observation: CompletedHandObservation,
    signal?: AbortSignal
  ): Promise<HorseDecisionWorkerAck> {
    const request = {
      ...observation,
      type: 'OBSERVE_COMPLETED_HAND' as const,
      requestId: this.nextRequestId++,
    };
    return this.enqueue<HorseDecisionWorkerAck>(request, 'ACK', signal);
  }

  commitDecisionEffects(
    authority: { generation: number; fence: string },
    effects: readonly HorseMindDecisionEffect[]
  ): Promise<HorseDecisionWorkerAck> {
    const request: CommitDecisionEffectsRequest = {
      ...authority,
      type: 'COMMIT_DECISION_EFFECTS',
      requestId: this.nextRequestId++,
      effects: structuredClone([...effects]),
    };
    return this.enqueue<HorseDecisionWorkerAck>(request, 'ACK', undefined, true);
  }

  decideDiscard(
    snapshot: PineappleDiscardSnapshot,
    signal?: AbortSignal
  ): Promise<PineappleDiscardResult> {
    const request: DecidePineappleDiscardRequest = {
      ...snapshot,
      type: 'DECIDE_DISCARD',
      requestId: this.nextRequestId++,
    };
    return this.enqueue<PineappleDiscardResult>(request, 'DISCARD_RESULT', signal);
  }

  /**
   * Stop accepting new work, drain every already-accepted FIFO entry, then ask
   * the worker to flush and stop its owned services. No abrupt normal path.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.phase === 'stopped') return Promise.resolve();
    if (this.phase === 'failed') {
      this.stopPromise = this.terminateWorker();
      return this.stopPromise;
    }
    if (this.phase === 'starting') {
      // No live dealer can exist before READY, so there is no accepted hand
      // work to drain. Cancel startup immediately instead of making the
      // process shutdown wait for the 90-second READY fault deadline. This is
      // an intentional termination, not a worker crash, and lets GameServer
      // release leadership inside the process-wide 40-second shutdown bound.
      const error = new HorseDecisionAbortedError(
        'live horse decision worker startup was cancelled by shutdown'
      );
      this.phase = 'stopping';
      clearTimeout(this.readyTimer);
      this.stopStatusTimer();
      this.rejectReady(error);
      for (const job of this.queue.splice(0)) {
        this.clearJobDeadline(job);
        this.detachAbort(job);
        if (!job.settled) {
          job.settled = true;
          job.reject(error);
        }
      }
      // Worker events already queued by Node may arrive between terminate()
      // admission and its promise settling. They belong to this intentional
      // cancellation and must not be reclassified as a production crash.
      this.startupCancellationInProgress = true;
      this.shutdownAcknowledged = true;
      this.stopPromise = this.terminateWorker().then(
        () => {
          this.phase = 'stopped';
        },
        (terminationError) => {
          const failure =
            terminationError instanceof Error
              ? terminationError
              : new Error(String(terminationError));
          this.lastError = failure.message;
          this.phase = 'failed';
          throw failure;
        }
      );
      return this.stopPromise;
    }
    this.phase = 'stopping';
    this.stopStatusTimer();
    this.stopPromise = new Promise<void>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    this.maybeDispatch();
    return this.stopPromise;
  }

  private enqueue<T extends JobResult>(
    request: HorseDecisionJobRequest,
    expected: T['type'],
    signal?: AbortSignal,
    priority = false
  ): Promise<T> {
    if (this.phase === 'stopping' || this.phase === 'stopped') {
      return Promise.reject(new Error('live horse decision worker is stopping'));
    }
    if (this.phase === 'failed') {
      return Promise.reject(new Error(this.lastError ?? 'live horse decision worker failed'));
    }
    if (signal?.aborted) return Promise.reject(new HorseDecisionAbortedError());

    return new Promise<T>((resolve, reject) => {
      const enqueuedAt = Date.now();
      const job: QueuedJob = {
        request,
        expected,
        resolve: (result) => resolve(result as T),
        reject,
        signal,
        settled: false,
        enqueuedAt,
        deadlineTimer: null,
      };
      job.deadlineTimer = setTimeout(() => this.onJobDeadline(job), this.jobTimeoutMs);
      job.deadlineTimer.unref?.();
      if (signal) {
        job.abortListener = () => this.abort(job);
        signal.addEventListener('abort', job.abortListener, { once: true });
      }
      if (priority && this.priorityInsertIndex !== null) {
        this.queue.splice(this.priorityInsertIndex, 0, job);
        this.priorityInsertIndex += 1;
      } else {
        this.queue.push(job);
      }
      this.maybeDispatch();
    });
  }

  private abort(job: QueuedJob): void {
    if (job.settled) return;
    job.settled = true;
    this.detachAbort(job);
    job.reject(new HorseDecisionAbortedError());

    if (this.active === job) {
      // HorseLogic is synchronous and cannot be interrupted mid-instruction.
      // The response is therefore stale-discarded; CANCEL still lets the
      // worker skip the request when it has not started yet.
      this.safePost({ type: 'CANCEL', requestId: job.request.requestId });
      return;
    }

    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    this.clearJobDeadline(job);
    this.maybeDispatch();
  }

  private maybeDispatch(): void {
    const canDispatch =
      this.phase === 'ready' || (this.phase === 'stopping' && this.readyAt !== null);
    if (this.active || this.dispatchHoldDepth > 0 || !canDispatch) return;
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      this.active = job;
      this.activeStartedAt = Date.now();
      this.safePost(job.request);
      return;
    }
    if (this.phase === 'stopping' && !this.shutdownPosted) {
      this.shutdownPosted = true;
      this.safePost({ type: 'SHUTDOWN' });
    }
  }

  private onMessage(message: HorseDecisionWorkerResponse): void {
    if (message.type === 'READY') {
      if (this.phase !== 'starting' && this.phase !== 'stopping') {
        this.fail(new Error(`unexpected READY while worker is ${this.phase}`));
        return;
      }
      if (!horseDecisionSolverStoresAreValid(message.solverStores)) {
        this.fail(new Error('live horse decision worker returned invalid solver-store identity'));
        return;
      }
      this.readyAt = Date.now();
      clearTimeout(this.readyTimer);
      this.solverStores = structuredClone(message.solverStores);
      this.solverPolicyArtifact = structuredClone(message.solverPolicyArtifact);
      this.governor = { ...message.governor };
      this.statusSampledAt = Date.now();
      this.resolveReady({
        solverStores: this.solverStores,
        solverPolicyArtifact: this.solverPolicyArtifact,
        governor: this.governor,
      });
      if (this.phase === 'starting') this.phase = 'ready';
      this.startStatusTimer();
      this.maybeDispatch();
      return;
    }

    if (message.type === 'STOPPED') {
      if (this.phase !== 'stopping' || this.active || this.queue.length > 0) {
        this.fail(new Error('live horse decision worker stopped before its FIFO drained'));
        return;
      }
      // STOPPED means the worker already drained its owned durable services.
      // Acknowledge before terminate(): Node may emit `exit` before the
      // terminate promise resolves, and that normal exit is not fatal.
      this.shutdownAcknowledged = true;
      void this.terminateWorker()
        .then(
          () => {
            this.phase = 'stopped';
            this.resolveStop?.();
            this.clearStopResolvers();
          },
          (error) => this.fail(error instanceof Error ? error : new Error(String(error)))
        )
        .catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
      return;
    }

    if (message.type === 'ERROR' && message.requestId === null) {
      this.fail(new Error(message.message));
      return;
    }

    const active = this.active;
    if (!active) {
      this.fail(new Error(`unexpected horse decision worker message ${message.type}`));
      return;
    }

    if (message.requestId !== active.request.requestId) {
      this.fail(
        new Error(
          `horse decision worker broke FIFO: expected ${active.request.requestId}, received ${message.requestId}`
        )
      );
      return;
    }
    if (
      message.generation !== active.request.generation ||
      message.fence !== active.request.fence
    ) {
      this.fail(
        new Error(
          `horse decision worker returned a mismatched lifecycle fence for ${message.requestId}`
        )
      );
      return;
    }
    if (message.type === 'ERROR') {
      // A job-level ERROR is still worker-runtime corruption: every production
      // request is built by this typed client. Continuing would leave health
      // green while live seats repeatedly degrade to safety actions.
      this.fail(new Error(message.message));
      return;
    }
    if (message.type !== 'CANCELLED' && message.type !== active.expected) {
      this.fail(
        new Error(`horse decision worker returned ${message.type}; expected ${active.expected}`)
      );
      return;
    }
    if (message.type === 'ACK') {
      const expectedOperation =
        active.request.type === 'OBSERVE_COMPLETED_HAND'
          ? 'OBSERVE_COMPLETED_HAND'
          : active.request.type === 'COMMIT_DECISION_EFFECTS'
            ? 'COMMIT_DECISION_EFFECTS'
            : null;
      if (message.operation !== expectedOperation) {
        this.fail(
          new Error(
            `horse decision worker ACK operation mismatch: expected ${String(expectedOperation)}, received ${message.operation}`
          )
        );
        return;
      }
    }

    this.active = null;
    this.clearActiveDeadline();
    this.clearJobDeadline(active);
    this.detachAbort(active);
    this.lastCompletedAt = Date.now();
    this.completedJobs += 1;
    if (
      message.type === 'FAST_RESULT' ||
      message.type === 'DEEP_RESULT' ||
      message.type === 'DISCARD_RESULT'
    ) {
      this.lastComputeMs = message.computeMs;
      if (this.governor) this.governor = { ...this.governor, scale: message.governorScale };
    } else if (message.type === 'STATUS_RESULT') {
      if (!horseDecisionSolverStoresAreValid(message.solverStores)) {
        this.fail(new Error('live horse decision worker status lost solver-store identity'));
        return;
      }
      this.solverStores = structuredClone(message.solverStores);
      this.solverPolicyArtifact = structuredClone(message.solverPolicyArtifact);
      this.governor = { ...message.governor };
      this.statusSampledAt = this.lastCompletedAt;
    }
    if (!active.settled) {
      active.settled = true;
      if (message.type === 'CANCELLED') active.reject(new HorseDecisionAbortedError());
      else active.resolve(message as JobResult);
    }
    this.maybeDispatch();
  }

  private detachAbort(job: QueuedJob): void {
    if (job.signal && job.abortListener) {
      job.signal.removeEventListener('abort', job.abortListener);
      job.abortListener = undefined;
    }
  }

  private fail(error: Error): void {
    if (this.phase === 'failed' || this.phase === 'stopped') return;
    this.lastError = errorMessage(error);
    this.phase = 'failed';
    clearTimeout(this.readyTimer);
    this.stopStatusTimer();
    this.clearActiveDeadline();
    this.rejectReady(error);
    if (this.active) {
      this.clearJobDeadline(this.active);
      this.detachAbort(this.active);
      if (!this.active.settled) this.active.reject(error);
      this.active = null;
    }
    for (const job of this.queue.splice(0)) {
      this.clearJobDeadline(job);
      this.detachAbort(job);
      if (!job.settled) job.reject(error);
    }
    this.rejectStop?.(error);
    this.clearStopResolvers();
    // Failure is terminal and never constructs a replacement worker.
    void this.terminateWorker().catch(() => undefined);
    if (!this.fatalNotified) {
      this.fatalNotified = true;
      // Production deliberately throws from this callback so index's fatal
      // shutdown owns the exit. Run it after this failure transition is fully
      // observable and let callback exceptions surface as uncaught failures.
      queueMicrotask(() => this.onFatal?.(error));
    }
  }

  private clearStopResolvers(): void {
    this.resolveStop = null;
    this.rejectStop = null;
  }

  private safePost(message: HorseDecisionWorkerRequest): boolean {
    try {
      this.worker.postMessage(message);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private onJobDeadline(job: QueuedJob): void {
    if (this.active === job) {
      this.fail(
        new Error(
          `live horse decision worker job ${job.request.requestId} (${job.request.type}) exceeded its ${this.jobTimeoutMs}ms queue-plus-compute deadline`
        )
      );
      return;
    }
    if (job.settled) return;
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    job.settled = true;
    this.detachAbort(job);
    job.reject(
      new HorseDecisionExpiredError(
        `horse decision expired after ${this.jobTimeoutMs}ms before worker dispatch`
      )
    );
    this.maybeDispatch();
  }

  private clearJobDeadline(job: QueuedJob): void {
    if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
    job.deadlineTimer = null;
  }

  private clearActiveDeadline(): void {
    this.activeStartedAt = null;
  }

  private startStatusTimer(): void {
    if (this.statusTimer || this.phase !== 'ready') return;
    this.statusTimer = setInterval(
      () => this.queueStatusRefresh(),
      LiveHorseDecisionWorkerClient.STATUS_INTERVAL_MS
    );
    this.statusTimer.unref?.();
  }

  private stopStatusTimer(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  private queueStatusRefresh(): void {
    if (this.phase !== 'ready') return;
    if (this.active?.request.type === 'STATUS') return;
    if (this.queue.some((job) => !job.settled && job.request.type === 'STATUS')) return;
    const request = {
      type: 'STATUS' as const,
      requestId: this.nextRequestId++,
      generation: 0,
      fence: 'worker:status',
    };
    void this.enqueue<HorseDecisionWorkerStatusResult>(request, 'STATUS_RESULT').catch(() => {
      /* stop/failure already owns the terminal state */
    });
  }

  private terminateWorker(): Promise<void> {
    if (!this.terminationPromise) {
      this.terminationPromise = this.worker.terminate().then(() => undefined);
    }
    return this.terminationPromise;
  }
}

let singleton: LiveHorseDecisionWorkerClient | null = null;

export async function startLiveHorseDecisionWorker(
  options: LiveHorseDecisionWorkerClientOptions = {}
): Promise<LiveHorseDecisionWorkerClient> {
  if (!singleton) singleton = new LiveHorseDecisionWorkerClient(options);
  await singleton.ready();
  return singleton;
}

export function getLiveHorseDecisionWorker(): LiveHorseDecisionWorkerClient {
  if (!singleton) throw new Error('live horse decision worker has not been started');
  return singleton;
}

export function liveHorseDecisionWorkerStatus(): LiveHorseDecisionWorkerStatus {
  return singleton?.status() ?? stoppedStatus();
}

export async function stopLiveHorseDecisionWorker(): Promise<void> {
  const owned = singleton;
  if (!owned) return;
  try {
    await owned.stop();
  } finally {
    if (singleton === owned) singleton = null;
  }
}
