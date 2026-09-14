import { Worker } from 'node:worker_threads';

import {
  createHorseExecutionWitness,
  retireHorseExecutionWitness,
} from '../HorseExecutionWitness.js';
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
import { horseDecisionReceiptIsValid } from './responseValidation.js';
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
  /** Caller deadline from enqueue and worker-integrity deadline from dispatch. */
  jobTimeoutMs?: number;
  /**
   * How many jobs may be posted to the worker before the one it is running
   * answers. The worker still runs them one at a time, oldest first; see the
   * class comment for why the order does not depend on this being one.
   */
  maxInFlight?: number;
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
  /**
   * How many jobs this lane will keep posted to the worker at once.
   *
   * Reported because the lane's throughput is `maxInFlight / round trip` and
   * that arithmetic was invisible while the queue drowned: an operator could
   * see 520 queued and 49 expiring a second with no way to tell what the lane
   * was configured to sustain.
   */
  maxInFlight: number;
  queueDepth: number;
  /** Of `queueDepth`, the jobs already posted and waiting on the worker's own port. */
  inFlightJobs: number;
  activeRequestId: number | null;
  activeJobAgeMs: number | null;
  oldestQueuedAgeMs: number | null;
  lastCompletedAt: number | null;
  lastComputeMs: number | null;
  completedJobs: number;
  /** Accepted operations whose queue-plus-compute caller deadline elapsed. */
  expiredJobs: number;
  lastExpiredAt: number | null;
  lastExpiredRequestType: HorseDecisionJobRequest['type'] | null;
  lastExpiredPhase: 'queued' | 'active' | null;
  /** Requests rejected at worker validation while its FIFO and runtime stayed healthy. */
  recoverableRequestErrors: number;
  lastRecoverableRequestErrorAt: number | null;
  lastRecoverableRequestErrorType: HorseDecisionJobRequest['type'] | null;
  lastRecoverableRequestError: string | null;
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
 * The request used its complete queue-plus-compute action budget. This is not
 * an authority cancellation: the turn may still be current and must take the
 * caller's fail-safe action instead of being silently abandoned. A separately
 * measured execution deadline still terminal-fails a genuinely wedged worker.
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
  /** Caller/action-clock deadline measured from enqueue. */
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  /** Worker-integrity deadline measured only after this job is posted. */
  executionTimer: ReturnType<typeof setTimeout> | null;
  /** One poll-turn grace for a worker response already waiting on its port. */
  executionDeadlineCheck: ReturnType<typeof setImmediate> | null;
}

const stoppedStatus = (): LiveHorseDecisionWorkerStatus => ({
  phase: 'stopped',
  startedAt: null,
  readyAt: null,
  maxInFlight: 0,
  queueDepth: 0,
  inFlightJobs: 0,
  activeRequestId: null,
  activeJobAgeMs: null,
  oldestQueuedAgeMs: null,
  lastCompletedAt: null,
  lastComputeMs: null,
  completedJobs: 0,
  expiredJobs: 0,
  lastExpiredAt: null,
  lastExpiredRequestType: null,
  lastExpiredPhase: null,
  recoverableRequestErrors: 0,
  lastRecoverableRequestErrorAt: null,
  lastRecoverableRequestErrorType: null,
  lastRecoverableRequestError: null,
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
 * Main-thread owner of the process-wide single FIFO.
 *
 * ── ONE LANE, NOT ONE MESSAGE AT A TIME (2026-09-11) ────────────────────────
 *
 * This used to post exactly one job and wait for its answer before posting the
 * next, "so worker scheduling cannot reorder RNG-consuming decisions". The
 * order never depended on that. A MessagePort delivers in post order, the
 * worker chains what it receives onto one promise, oldest first, and it answers
 * in that same order. What one-at-a-time really bought was an idle worker:
 * every job paid a full round trip through the MAIN event loop, where the
 * answer waited its turn behind table timers, broadcasts and settlement before
 * the next job could even be posted, and that gap was charged to every
 * decision queued behind it.
 *
 * Production, 2026-09-11 ~11:50 UTC, ~185 tables dealing: 126-156 decisions
 * queued, the oldest 2.6-3.8 s old, the lane finishing about 40 jobs a second
 * at 2-38 ms of compute each, while no engine thread was busier than 60% of a
 * core. Since the 10:55 build the queue had averaged 98-130 deep (it was
 * 2-7 all morning) and horses acted seconds after the think time they chose,
 * so hands dragged for every seat at those tables.
 *
 * Now up to `maxInFlight` jobs are posted ahead, so the worker always has its
 * next job waiting on its own port. Everything else is unchanged:
 *   - FIFO is still enforced: every answer must be for the oldest posted job,
 *     and anything else is terminal protocol corruption, as before.
 *   - An abort or expiry of a posted job sends CANCEL (the worker skips a job
 *     it has not started) and the job stays a FIFO owner until its terminal
 *     answer arrives, exactly as the single active job always did.
 *   - The integrity (execution) clock starts when a job reaches the HEAD of
 *     the posted FIFO, never when it is posted. A job waiting behind a slow
 *     predecessor is not charged that predecessor's compute; charging it would
 *     fail a healthy worker, and a failed worker restarts the whole fleet (see
 *     onJobDeadline).
 *   - The dispatch barrier still holds every post, so a priority effect commit
 *     still lands after older work and before the TURN_CHANGE work it must
 *     precede.
 * The worker turns its event loop between jobs (HorseDecisionWorkerRuntime
 * .receive), so a full window can never starve its timers, its CANCEL handling
 * or its governor's sampler.
 */
export class LiveHorseDecisionWorkerClient {
  private static readonly DEFAULT_READY_TIMEOUT_MS = 90_000;
  private static readonly DEFAULT_JOB_TIMEOUT_MS = 8_000;
  /**
   * Covers a slow main-loop round trip several times over at 2-40 ms of compute
   * per job, and stays small enough that an abort or expiry usually reaches the
   * worker before the job it cancels has started.
   */
  /**
   * ── WHY 4 BECAME 32 (2026-09-11, evening) ─────────────────────────────────
   *
   * The pipeline exists because every job pays a round trip through the MAIN
   * event loop (see the note above this class). Its throughput is therefore
   * `maxInFlight / mainLoopRoundTrip`, and 4 was derived when that round trip
   * was small and ~185 tables were dealing.
   *
   * Measured on engine-01 at 20:2x UTC, 470 tables dealing and 2,646 horses
   * seated after the day's fixes put them back on the floor:
   *
   *     poker_event_loop_delay_p50_ms                     309
   *     poker_main_event_loop_governor_scale              0.2   (already shedding)
   *     poker_horse_decision_worker_event_loop_delay_p50    22   (the worker is NOT busy)
   *     poker_horse_decision_worker_last_compute_ms       0.07 .. 337
   *     poker_horse_decision_worker_queue_depth           ~520
   *     poker_horse_decision_worker_oldest_queued_age_ms  ~8,200 (pinned at the deadline)
   *     poker_horse_decision_worker_expired_jobs          +49 per second
   *     poker_horse_decision_fallbacks_total              13,973
   *
   * Four in flight against a 309 ms round trip is about 13 jobs a second. The
   * queue sat 520 deep with its head at the 8-second caller deadline, so ~49
   * decisions a second EXPIRED, and an expired decision is a seat taking the
   * legal check or fold without thinking. Fourteen thousand hands were played
   * that way. The worker meanwhile ran a 22 ms loop: it was never the
   * constraint, the serialisation was.
   *
   * 32 gives about 100 jobs a second at the same round trip, which is roughly
   * twice the measured shortfall, and it is still bounded: the worker holds at
   * most 32 posted jobs, most of them costing well under a millisecond.
   *
   * NOTHING ELSE MOVES. FIFO ownership, CANCEL on abort or expiry, the
   * integrity clock starting at the HEAD of the posted FIFO, and the dispatch
   * barrier are all independent of the depth - they are pinned in
   * client.test.ts and none of those pins changes here. The one real cost of a
   * deeper pipeline is that a cancel more often arrives after the job it
   * cancels has started, which wastes a sub-millisecond computation.
   *
   * THIS IS NOT A CAPACITY FIX. The main loop is genuinely saturated at 309 ms
   * with its own governor at 0.2, and that is engine-01's three cores against a
   * floor that doubled today. This stops the decision lane being serialised
   * behind that saturation; it does not create headroom that is not there.
   */
  private static readonly DEFAULT_MAX_IN_FLIGHT = 32;
  private static readonly STATUS_INTERVAL_MS = 1_000;
  private readonly worker: WorkerLike;
  private readonly onFatal?: (error: Error) => void;
  private readonly jobTimeoutMs: number;
  private readonly maxInFlight: number;
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
  private expiredJobs = 0;
  private lastExpiredAt: number | null = null;
  private lastExpiredRequestType: HorseDecisionJobRequest['type'] | null = null;
  private lastExpiredPhase: 'queued' | 'active' | null = null;
  private recoverableRequestErrors = 0;
  private lastRecoverableRequestErrorAt: number | null = null;
  private lastRecoverableRequestErrorType: HorseDecisionJobRequest['type'] | null = null;
  private lastRecoverableRequestError: string | null = null;
  private nextRequestId = 1;
  /** Accepted jobs not yet posted to the worker. */
  private readonly queue: QueuedJob[] = [];
  /**
   * Posted jobs, oldest first. The worker answers them in this order; the head
   * is the job it is running (or about to run).
   */
  private readonly inFlight: QueuedJob[] = [];
  /** When the current head of `inFlight` became the worker's running job. */
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
    const maxInFlight = Math.floor(
      options.maxInFlight ?? LiveHorseDecisionWorkerClient.DEFAULT_MAX_IN_FLIGHT
    );
    this.maxInFlight = Number.isSafeInteger(maxInFlight)
      ? Math.max(1, maxInFlight)
      : LiveHorseDecisionWorkerClient.DEFAULT_MAX_IN_FLIGHT;
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
    const active = this.inFlight[0] ?? null;
    // Everything still waiting for its turn: posted jobs behind the head, and
    // jobs not yet posted. The head is running and is reported as active.
    const oldestQueued = [...this.inFlight.slice(1), ...this.queue].reduce<QueuedJob | null>(
      (oldest, job) =>
        job.settled || (oldest && oldest.enqueuedAt <= job.enqueuedAt) ? oldest : job,
      null
    );
    return {
      phase: this.phase,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      maxInFlight: this.maxInFlight,
      queueDepth: this.queue.length + this.inFlight.length,
      inFlightJobs: this.inFlight.length,
      activeRequestId: active?.request.requestId ?? null,
      activeJobAgeMs:
        active && this.activeStartedAt !== null ? Math.max(0, now - this.activeStartedAt) : null,
      oldestQueuedAgeMs: oldestQueued ? Math.max(0, now - oldestQueued.enqueuedAt) : null,
      lastCompletedAt: this.lastCompletedAt,
      lastComputeMs: this.lastComputeMs,
      completedJobs: this.completedJobs,
      expiredJobs: this.expiredJobs,
      lastExpiredAt: this.lastExpiredAt,
      lastExpiredRequestType: this.lastExpiredRequestType,
      lastExpiredPhase: this.lastExpiredPhase,
      recoverableRequestErrors: this.recoverableRequestErrors,
      lastRecoverableRequestErrorAt: this.lastRecoverableRequestErrorAt,
      lastRecoverableRequestErrorType: this.lastRecoverableRequestErrorType,
      lastRecoverableRequestError: this.lastRecoverableRequestError,
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
        executionTimer: null,
        executionDeadlineCheck: null,
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

    if (this.inFlight.includes(job)) {
      // HorseLogic is synchronous and cannot be interrupted mid-instruction.
      // A posted job's response is therefore stale-discarded; CANCEL still
      // lets the worker skip the request when it has not started yet.
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
    if (this.dispatchHoldDepth > 0 || !canDispatch) return;
    while (this.queue.length > 0 && this.inFlight.length < this.maxInFlight) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      this.inFlight.push(job);
      if (this.inFlight.length === 1) this.startExecutionClock(job);
      if (!this.safePost(job.request)) return;
    }
    if (
      this.phase === 'stopping' &&
      !this.shutdownPosted &&
      this.inFlight.length === 0 &&
      this.queue.length === 0
    ) {
      this.shutdownPosted = true;
      this.safePost({ type: 'SHUTDOWN' });
    }
  }

  /**
   * The enqueue timer is the table/action-clock budget. A separate timer starts
   * when a job becomes the worker's running job - the head of the posted FIFO -
   * so a request that spent most of that budget waiting, in either queue,
   * cannot be mistaken for a wedged worker after only a few milliseconds of
   * actual execution. A real wedge is still terminal after a full worker
   * execution budget.
   */
  private startExecutionClock(job: QueuedJob): void {
    this.activeStartedAt = Date.now();
    job.executionTimer = setTimeout(() => this.onExecutionDeadline(job), this.jobTimeoutMs);
    job.executionTimer.unref?.();
  }

  /** The head's terminal answer arrived: retire it and start its successor's clock. */
  private retireHead(job: QueuedJob): void {
    if (this.inFlight[0] === job) this.inFlight.shift();
    this.clearActiveDeadline();
    this.clearJobDeadline(job);
    this.detachAbort(job);
    const next = this.inFlight[0];
    if (next) this.startExecutionClock(next);
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
      if (this.phase !== 'stopping' || this.inFlight.length > 0 || this.queue.length > 0) {
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

    const active = this.inFlight[0];
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
      // Only the runtime's explicit structured-clone validation rejection is
      // safe to isolate to one caller. A plain typed ERROR can represent Horse
      // execution, durable-effect, or worker-runtime corruption and remains
      // process-fatal. This distinction prevents one malformed Pineapple
      // snapshot from restarting the fleet without hiding real worker faults.
      if (message.recoverable !== true) {
        this.fail(new Error(message.message));
        return;
      }
      const error = new Error(message.message);
      this.retireHead(active);
      this.lastCompletedAt = Date.now();
      this.recoverableRequestErrors += 1;
      this.lastRecoverableRequestErrorAt = this.lastCompletedAt;
      this.lastRecoverableRequestErrorType = active.request.type;
      this.lastRecoverableRequestError = error.message;
      if (!active.settled) {
        active.settled = true;
        active.reject(error);
      }
      this.maybeDispatch();
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

    if (
      (message.type === 'FAST_RESULT' && active.request.type === 'DECIDE_FAST') ||
      (message.type === 'DEEP_RESULT' && active.request.type === 'DECIDE_DEEP')
    ) {
      if (
        !message.decision ||
        typeof message.decision !== 'object' ||
        Array.isArray(message.decision) ||
        (message.decision.policyFallback !== undefined &&
          message.decision.policyFallback !== 'brain_exception')
      ) {
        this.fail(new Error('horse decision worker returned invalid fallback provenance'));
        return;
      }
      if (!horseDecisionReceiptIsValid(message.decision)) {
        this.fail(new Error('horse decision worker returned invalid policy receipt'));
        return;
      }
      const witness = createHorseExecutionWitness(active.request, message.decision, {
        requestId: message.requestId,
        lane: message.type === 'FAST_RESULT' ? 'fast' : 'deep',
        computeMs: message.computeMs,
        governorScale: message.governorScale,
      });
      message.decision.executionWitness = witness;
      // A result received after abort/expiry is never delivered to the table.
      // Retire it here; an executor callback cannot account for this response.
      if (active.settled) retireHorseExecutionWitness(witness, 'caller_settled');
    }

    this.retireHead(active);
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
    for (const job of this.inFlight.splice(0)) {
      this.clearJobDeadline(job);
      this.detachAbort(job);
      if (!job.settled) job.reject(error);
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
    if (job.settled) return;
    // This callback owns the elapsed enqueue timer. Keep the independently
    // armed execution timer intact when the job is already running.
    job.deadlineTimer = null;
    const posted = this.inFlight.includes(job);
    this.noteExpiredJob(job, this.inFlight[0] === job ? 'active' : 'queued');
    job.settled = true;
    this.detachAbort(job);
    job.reject(
      new HorseDecisionExpiredError(
        posted
          ? `horse decision expired after ${this.jobTimeoutMs}ms of queue-plus-compute time`
          : `horse decision expired after ${this.jobTimeoutMs}ms before worker dispatch`
      )
    );
    if (posted) {
      // HorseLogic is synchronous. Keep this request as a FIFO owner until
      // its terminal response arrives, then stale-discard that response just
      // like an active authority abort. Killing the sole worker here caused a
      // full-fleet restart when a 7.8-second queue wait left a healthy request
      // only milliseconds of the enqueue deadline to compute. CANCEL lets the
      // worker skip it if it is still waiting behind older posted work.
      this.safePost({ type: 'CANCEL', requestId: job.request.requestId });
      return;
    }
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    this.maybeDispatch();
  }

  private onExecutionDeadline(job: QueuedJob): void {
    if (this.inFlight[0] !== job || this.phase === 'failed' || this.phase === 'stopped') return;
    job.executionTimer = null;
    // A worker may have posted its response before this timer became runnable
    // while the main loop was busy. Timers run before MessagePort's poll work,
    // so give that already-completed response one poll turn to retire the head.
    // A genuinely wedged worker still fails in this same event-loop cycle.
    job.executionDeadlineCheck = setImmediate(() => {
      job.executionDeadlineCheck = null;
      if (this.inFlight[0] !== job || this.phase === 'failed' || this.phase === 'stopped') return;
      this.fail(
        new Error(
          `live horse decision worker job ${job.request.requestId} (${job.request.type}) exceeded its ${this.jobTimeoutMs}ms execution deadline after dispatch`
        )
      );
    });
    job.executionDeadlineCheck.unref?.();
  }

  private noteExpiredJob(job: QueuedJob, phase: 'queued' | 'active'): void {
    this.expiredJobs += 1;
    this.lastExpiredAt = Date.now();
    this.lastExpiredRequestType = job.request.type;
    this.lastExpiredPhase = phase;
  }

  private clearJobDeadline(job: QueuedJob): void {
    if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
    job.deadlineTimer = null;
    if (job.executionTimer) clearTimeout(job.executionTimer);
    job.executionTimer = null;
    if (job.executionDeadlineCheck) clearImmediate(job.executionDeadlineCheck);
    job.executionDeadlineCheck = null;
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
    if (this.inFlight.some((job) => job.request.type === 'STATUS')) return;
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
