/**
 * Process-wide worker_threads pool for live all-in equity and insurance.
 *
 * This boundary is deliberately fail-closed: live-table CPU work is never
 * replayed synchronously when a worker is unavailable, late, malformed, or
 * dead. Cosmetic equity may be omitted and insurance may be skipped, but the
 * authoritative event loop remains available to deal and finish the hand.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { Card } from '../../types.js';
import type { EquityOptions, InsuranceEquityComponents } from './equityWorker.js';
import { hashSeed } from './SeededRandom.js';

const DEFAULT_JOB_TIMEOUT_MS = 2_500;
const DEFAULT_HARD_JOB_TIMEOUT_MS = 15_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const RESPAWN_DELAY_MS = 250;
const DEFAULT_RESPAWN_BUDGET = 10;

export type EquityWorkerPoolPhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'stopping'
  | 'stopped';

export interface EquityWorkerPoolStatus {
  phase: EquityWorkerPoolPhase;
  routingReady: boolean;
  acceptingWork: boolean;
  recoveryInFlight: boolean;
  configuredWorkers: number;
  readyWorkers: number;
  busyWorkers: number;
  queueDepth: number;
  oldestQueuedAgeMs: number;
  lastCompletionAgeMs: number | null;
  lastError: string | null;
}

/**
 * Optional calculator capacity may recover without taking a healthy dealer
 * out of service. Startup, exhausted recovery, and shutdown still fail closed.
 */
export function equityWorkerPoolPreservesDealerLiveness(status: EquityWorkerPoolStatus): boolean {
  return status.routingReady;
}

export class EquityWorkerUnavailableError extends Error {
  constructor(message = 'Equity worker pool is unavailable') {
    super(message);
    this.name = 'EquityWorkerUnavailableError';
  }
}

export class EquityWorkerPoolAbortedError extends EquityWorkerUnavailableError {
  constructor(message = 'Equity worker pool stopped before the operation completed') {
    super(message);
    this.name = 'EquityWorkerPoolAbortedError';
  }
}

export class EquityWorkerTimeoutError extends EquityWorkerUnavailableError {
  constructor(timeoutMs: number) {
    super(`Equity worker operation timed out after ${timeoutMs}ms`);
    this.name = 'EquityWorkerTimeoutError';
  }
}

interface WorkerLike {
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  unref?(): void;
}

interface EquityPayload {
  type: 'EQUITY';
  hands: Card[][];
  board: Card[];
  deadCards: Card[];
  iters: number;
  opts: EquityOptions;
  seed: number;
}

interface InsurancePayload {
  type: 'INSURANCE_ALL';
  hands: Card[][];
  board: Card[];
  variant: string;
  shortDeck: boolean;
}

interface Job<T = any> {
  id: number;
  payload: EquityPayload | InsurancePayload;
  enqueuedAt: number;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  validate: (message: Record<string, unknown>) => T;
  softTimer?: ReturnType<typeof setTimeout>;
  hardTimer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface WorkerSlot {
  worker: WorkerLike;
  ready: boolean;
  down: boolean;
  job?: Job;
  readyTimer?: ReturnType<typeof setTimeout>;
}

export interface EquityWorkerPoolOptions {
  size?: number;
  disabled?: boolean;
  workerFactory?: () => WorkerLike;
  readyTimeoutMs?: number;
  /** Caller-facing queue plus compute SLA. Missing it does not kill a worker. */
  jobTimeoutMs?: number;
  /** Execution-only deadline that identifies a genuinely wedged worker. */
  hardJobTimeoutMs?: number;
  respawnBudget?: number;
}

export class EquityWorkerPool {
  private readonly size: number;
  private readonly disabled: boolean;
  private readonly workerFactory: () => WorkerLike;
  private readonly readyTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly hardJobTimeoutMs: number;
  private readonly maxRespawnBudget: number;
  private respawnBudget: number;
  private phase: EquityWorkerPoolPhase = 'idle';
  private readonly slots = new Set<WorkerSlot>();
  private readonly idle: WorkerSlot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private readonly respawnTimers = new Set<ReturnType<typeof setTimeout>>();
  private hasReachedReady = false;
  private lastCompletedAt: number | null = null;
  private lastError: string | null = null;
  private readinessPromise: Promise<EquityWorkerPoolStatus> | null = null;
  private resolveReadiness: ((status: EquityWorkerPoolStatus) => void) | null = null;
  private rejectReadiness: ((error: Error) => void) | null = null;
  private readinessTimer?: ReturnType<typeof setTimeout>;

  constructor(options: EquityWorkerPoolOptions = {}) {
    // Reserve one execution context for the authoritative event loop and one
    // for the process-wide HorseLogic worker. Horse League analysis runs in a
    // separately verified lowest-priority process, so the kernel preempts it
    // for these live lanes instead of giving it an equal share of this budget.
    // Configuration may reduce the pool but may never exceed the live budget.
    const workerCapacity = Math.max(1, availableParallelism() - 2);
    const requested = options.size ?? Number(process.env.EQUITY_WORKER_COUNT || workerCapacity);
    const normalizedRequested =
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : workerCapacity;
    this.size = Math.max(1, Math.min(workerCapacity, normalizedRequested));
    this.disabled = options.disabled === true || process.env.EQUITY_WORKERS === 'off';
    const sourceExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const workerUrl = new URL(`./equityWorker${sourceExtension}`, import.meta.url);
    this.workerFactory = options.workerFactory ?? (() => new Worker(workerUrl));
    this.readyTimeoutMs = Math.max(1, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    this.jobTimeoutMs = Math.max(1, options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
    this.hardJobTimeoutMs = Math.max(
      this.jobTimeoutMs + 1,
      options.hardJobTimeoutMs ?? DEFAULT_HARD_JOB_TIMEOUT_MS
    );
    this.maxRespawnBudget = Math.max(0, options.respawnBudget ?? DEFAULT_RESPAWN_BUDGET);
    this.respawnBudget = this.maxRespawnBudget;
  }

  status(): EquityWorkerPoolStatus {
    const now = Date.now();
    const readyWorkers = this.readyWorkerCount();
    const busyWorkers = [...this.slots].filter((slot) => slot.job && !slot.down).length;
    const recoveryInFlight = this.recoveryInFlight();
    const routingReady =
      this.hasReachedReady &&
      (readyWorkers === this.size || (this.phase === 'degraded' && recoveryInFlight));
    const acceptingWork =
      this.hasReachedReady &&
      readyWorkers > 0 &&
      (this.phase === 'ready' || this.phase === 'degraded');
    return {
      phase: this.phase,
      routingReady,
      acceptingWork,
      recoveryInFlight,
      configuredWorkers: this.size,
      readyWorkers,
      busyWorkers,
      queueDepth: this.queue.length,
      oldestQueuedAgeMs:
        this.queue.length === 0
          ? 0
          : Math.max(0, now - Math.min(...this.queue.map((job) => job.enqueuedAt))),
      lastCompletionAgeMs:
        this.lastCompletedAt === null ? null : Math.max(0, now - this.lastCompletedAt),
      lastError: this.lastError,
    };
  }

  isAvailable(): boolean {
    return this.status().acceptingWork;
  }

  /** Start all configured workers and wait for worker-authored READY messages. */
  ready(): Promise<EquityWorkerPoolStatus> {
    if (this.disabled) {
      this.phase = 'failed';
      this.lastError = 'Equity workers are disabled';
      return Promise.reject(new EquityWorkerUnavailableError(this.lastError));
    }
    if (this.phase === 'ready') return Promise.resolve(this.status());
    if (this.phase === 'stopping' || this.phase === 'stopped') {
      return Promise.reject(new EquityWorkerPoolAbortedError());
    }
    if (this.readinessPromise) return this.readinessPromise;

    this.phase = 'starting';
    this.readinessPromise = new Promise<EquityWorkerPoolStatus>((resolve, reject) => {
      this.resolveReadiness = resolve;
      this.rejectReadiness = reject;
    });
    this.readinessTimer = setTimeout(() => {
      if (this.phase !== 'starting') return;
      const error = new EquityWorkerUnavailableError(
        `Equity workers did not become ready within ${this.readyTimeoutMs}ms`
      );
      this.failStartup(error);
    }, this.readyTimeoutMs);
    this.readinessTimer.unref?.();
    for (let i = 0; i < this.size; i++) this.spawnWorker();
    return this.readinessPromise;
  }

  estimateEquity(
    hands: Card[][],
    board: Card[],
    deadCards: Card[] = [],
    iters = 1000,
    opts: EquityOptions = {},
    seed?: number
  ): Promise<number[]> {
    const useSeed = seed ?? this.deriveSeed(hands, board, deadCards, iters);
    return this.enqueue<number[]>(
      { type: 'EQUITY', hands, board, deadCards, iters, opts, seed: useSeed },
      (message) => {
        if (
          message.type !== 'EQUITY_RESULT' ||
          !Array.isArray(message.equities) ||
          message.equities.length !== hands.length ||
          message.equities.some(
            (value) =>
              typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1
          )
        ) {
          throw new Error('Malformed equity worker response');
        }
        return message.equities as number[];
      }
    );
  }

  estimateInsurance(
    hands: Card[][],
    board: Card[],
    variant: string,
    shortDeck = false
  ): Promise<InsuranceEquityComponents[]> {
    return this.enqueue<InsuranceEquityComponents[]>(
      { type: 'INSURANCE_ALL', hands, board, variant, shortDeck },
      (message) => {
        if (
          message.type !== 'INSURANCE_RESULT' ||
          !Array.isArray(message.components) ||
          message.components.length !== hands.length ||
          message.components.some((value) => {
            if (typeof value !== 'object' || value === null) return true;
            const component = value as Record<string, unknown>;
            return (
              typeof component.equity !== 'number' ||
              !Number.isFinite(component.equity) ||
              component.equity < 0 ||
              component.equity > 100 ||
              typeof component.strictLossPct !== 'number' ||
              !Number.isFinite(component.strictLossPct) ||
              component.strictLossPct < 0 ||
              component.strictLossPct > 100 ||
              typeof component.pushPct !== 'number' ||
              !Number.isFinite(component.pushPct) ||
              component.pushPct < 0 ||
              component.pushPct > 100 ||
              typeof component.exact !== 'boolean' ||
              typeof component.runouts !== 'number' ||
              !Number.isInteger(component.runouts) ||
              component.runouts <= 0
            );
          })
        ) {
          throw new Error('Malformed insurance worker response');
        }
        return message.components as InsuranceEquityComponents[];
      }
    );
  }

  private enqueue<T>(
    payload: EquityPayload | InsurancePayload,
    validate: (message: Record<string, unknown>) => T
  ): Promise<T> {
    if (!this.status().acceptingWork) {
      return Promise.reject(new EquityWorkerUnavailableError());
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = {
        id: this.nextId++,
        payload,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        validate,
        settled: false,
      };
      job.softTimer = setTimeout(() => this.onSoftJobTimeout(job), this.jobTimeoutMs);
      job.softTimer.unref?.();
      if (payload.type === 'INSURANCE_ALL') {
        // Real-money pricing outranks optional percentage displays. Preserve
        // FIFO within each class; never preempt an operation already running.
        const firstCosmetic = this.queue.findIndex((queued) => queued.payload.type === 'EQUITY');
        if (firstCosmetic < 0) this.queue.push(job as Job);
        else this.queue.splice(firstCosmetic, 0, job as Job);
      } else {
        this.queue.push(job as Job);
      }
      this.pump();
    });
  }

  private spawnWorker(isReplacement = false): void {
    if (this.phase === 'stopping' || this.phase === 'stopped' || this.disabled) return;
    let worker: WorkerLike;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this.lastError = this.errorMessage(error);
      this.scheduleRespawn();
      this.updatePhaseAfterCapacityChange();
      return;
    }
    const slot: WorkerSlot = { worker, ready: false, down: false };
    this.slots.add(slot);
    worker.on('message', (message) => this.onMessage(slot, message));
    worker.on('error', (error) => this.onWorkerDown(slot, error));
    worker.on('exit', (code) => this.onWorkerDown(slot, new Error(`Equity worker exited ${code}`)));
    worker.unref?.();
    if (isReplacement) {
      slot.readyTimer = setTimeout(() => {
        if (slot.down || slot.ready || !this.slots.has(slot)) return;
        this.retireWorker(
          slot,
          new EquityWorkerUnavailableError(
            `Equity replacement worker did not become ready within ${this.readyTimeoutMs}ms`
          )
        );
      }, this.readyTimeoutMs);
      slot.readyTimer.unref?.();
    }
    this.updatePhaseAfterCapacityChange();
  }

  private onMessage(slot: WorkerSlot, rawMessage: unknown): void {
    if (slot.down || typeof rawMessage !== 'object' || rawMessage === null) {
      if (!slot.down) this.retireWorker(slot, new Error('Malformed equity worker message'));
      return;
    }
    const message = rawMessage as Record<string, unknown>;
    if (message.type === 'READY') {
      if (slot.job) {
        this.retireWorker(slot, new Error('Equity worker sent READY while a job was active'));
        return;
      }
      if (!slot.ready) {
        this.clearSlotReadyTimer(slot);
        slot.ready = true;
        this.idle.push(slot);
      }
      this.updatePhaseAfterCapacityChange();
      this.pump();
      return;
    }

    const job = slot.job;
    if (!job || message.id !== job.id) {
      this.retireWorker(slot, new Error('Equity worker response did not match its active job'));
      return;
    }
    slot.job = undefined;
    if (message.type === 'ERROR') {
      this.lastError = String(message.error ?? 'Worker error');
      this.rejectJob(job, new EquityWorkerUnavailableError(this.lastError));
    } else {
      try {
        this.resolveJob(job, job.validate(message));
        this.lastCompletedAt = Date.now();
        this.respawnBudget = this.maxRespawnBudget;
      } catch (error) {
        this.rejectJob(job, new EquityWorkerUnavailableError(this.errorMessage(error)));
        this.retireWorker(slot, error);
        return;
      }
    }
    if (!slot.down && this.slots.has(slot)) this.idle.push(slot);
    this.pump();
  }

  private onSoftJobTimeout(job: Job): void {
    if (job.settled) return;
    const queueIndex = this.queue.indexOf(job);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    const error = new EquityWorkerTimeoutError(this.jobTimeoutMs);
    this.lastError = error.message;
    // The caller's latency budget is not evidence of a wedged worker. If the
    // operation is active, leave its hard deadline armed and validate its late
    // response before returning the same worker to the pool. If it was still
    // queued, simply remove it; no worker ever owned it.
    this.rejectJob(job, error, queueIndex < 0);
  }

  private onHardJobTimeout(slot: WorkerSlot, job: Job): void {
    if (slot.down || slot.job !== job) return;
    const error = new EquityWorkerUnavailableError(
      `Equity worker exceeded hard execution deadline after ${this.hardJobTimeoutMs}ms`
    );
    this.lastError = error.message;
    this.rejectJob(job, error);
    this.retireWorker(slot, error);
  }

  private pump(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const slot = this.idle.pop()!;
      if (slot.down || !slot.ready || slot.job) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      job.hardTimer = setTimeout(() => this.onHardJobTimeout(slot, job), this.hardJobTimeoutMs);
      job.hardTimer.unref?.();
      try {
        slot.worker.postMessage({ id: job.id, ...job.payload });
      } catch (error) {
        this.rejectJob(job, new EquityWorkerUnavailableError(this.errorMessage(error)));
        this.retireWorker(slot, error);
      }
    }
  }

  private retireWorker(slot: WorkerSlot, reason: unknown): void {
    if (slot.down) return;
    slot.down = true;
    this.clearSlotReadyTimer(slot);
    this.lastError = this.errorMessage(reason);
    this.slots.delete(slot);
    const idleIndex = this.idle.indexOf(slot);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    if (slot.job) {
      this.rejectJob(slot.job, new EquityWorkerUnavailableError(this.lastError));
      slot.job = undefined;
    }
    void slot.worker.terminate().catch(() => {});
    this.scheduleRespawn();
    this.updatePhaseAfterCapacityChange();
  }

  private onWorkerDown(slot: WorkerSlot, reason: unknown): void {
    this.retireWorker(slot, reason);
  }

  private scheduleRespawn(): void {
    if (
      this.phase === 'stopping' ||
      this.phase === 'stopped' ||
      this.respawnBudget <= 0 ||
      this.slots.size + this.respawnTimers.size >= this.size
    ) {
      return;
    }
    this.respawnBudget -= 1;
    const timer = setTimeout(() => {
      this.respawnTimers.delete(timer);
      if (this.phase === 'stopping' || this.phase === 'stopped' || this.disabled) return;
      this.spawnWorker(true);
    }, RESPAWN_DELAY_MS);
    this.respawnTimers.add(timer);
    timer.unref?.();
  }

  private updatePhaseAfterCapacityChange(): void {
    if (this.phase === 'stopping' || this.phase === 'stopped') return;
    const readyWorkers = this.readyWorkerCount();
    if (!this.hasReachedReady && readyWorkers === this.size && this.phase === 'starting') {
      this.hasReachedReady = true;
      this.phase = 'ready';
      this.resolveReadiness?.(this.status());
      this.clearReadinessWaiters();
      return;
    }
    if (!this.hasReachedReady) return;

    if (readyWorkers === this.size) this.phase = 'ready';
    else if (readyWorkers > 0 || this.recoveryInFlight()) this.phase = 'degraded';
    else this.phase = 'failed';

    if (readyWorkers === 0) this.rejectQueuedJobsWithoutCapacity();
  }

  private readyWorkerCount(): number {
    return [...this.slots].filter((slot) => slot.ready && !slot.down).length;
  }

  private recoveryInFlight(): boolean {
    if (!this.hasReachedReady) return false;
    return (
      this.respawnTimers.size > 0 ||
      [...this.slots].some((slot) => !slot.down && !slot.ready && slot.readyTimer !== undefined)
    );
  }

  private rejectQueuedJobsWithoutCapacity(): void {
    if (this.readyWorkerCount() > 0 || this.queue.length === 0) return;
    const error = new EquityWorkerUnavailableError(
      this.lastError ?? 'Equity worker pool has no ready workers'
    );
    for (const job of this.queue.splice(0)) this.rejectJob(job, error);
  }

  private clearSlotReadyTimer(slot: WorkerSlot): void {
    if (slot.readyTimer) clearTimeout(slot.readyTimer);
    slot.readyTimer = undefined;
  }

  private cancelRespawnTimers(): void {
    for (const timer of this.respawnTimers) clearTimeout(timer);
    this.respawnTimers.clear();
  }

  private failStartup(error: Error): void {
    this.lastError = error.message;
    this.phase = 'failed';
    this.rejectReadiness?.(error);
    this.clearReadinessWaiters();
    this.cancelRespawnTimers();
    for (const slot of this.slots) {
      slot.down = true;
      this.clearSlotReadyTimer(slot);
      void slot.worker.terminate().catch(() => {});
    }
    this.slots.clear();
    this.idle.length = 0;
  }

  private clearJobTimers(job: Job, keepHardTimer = false): void {
    if (job.softTimer) clearTimeout(job.softTimer);
    job.softTimer = undefined;
    if (!keepHardTimer) {
      if (job.hardTimer) clearTimeout(job.hardTimer);
      job.hardTimer = undefined;
    }
  }

  private resolveJob<T>(job: Job<T>, result: T): void {
    this.clearJobTimers(job);
    if (job.settled) return;
    job.settled = true;
    job.resolve(result);
  }

  private rejectJob(job: Job, error: Error, keepHardTimer = false): void {
    this.clearJobTimers(job, keepHardTimer);
    if (job.settled) return;
    job.settled = true;
    job.reject(error);
  }

  private clearReadinessWaiters(): void {
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    this.readinessTimer = undefined;
    this.resolveReadiness = null;
    this.rejectReadiness = null;
  }

  private deriveSeed(hands: Card[][], board: Card[], dead: Card[], iters: number): number {
    const keys: string[] = [];
    for (const hand of hands) for (const card of hand) keys.push(`h${card.rank}${card.suit}`);
    for (const card of board) keys.push(`b${card.rank}${card.suit}`);
    for (const card of dead) keys.push(`d${card.rank}${card.suit}`);
    keys.sort();
    return hashSeed(iters, ...keys);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async shutdown(): Promise<void> {
    if (this.phase === 'stopped') return;
    this.phase = 'stopping';
    const aborted = new EquityWorkerPoolAbortedError();
    this.rejectReadiness?.(aborted);
    this.clearReadinessWaiters();
    this.cancelRespawnTimers();
    for (const job of this.queue.splice(0)) this.rejectJob(job, aborted);
    const terminations: Promise<number>[] = [];
    for (const slot of this.slots) {
      slot.down = true;
      this.clearSlotReadyTimer(slot);
      if (slot.job) this.rejectJob(slot.job, aborted);
      terminations.push(slot.worker.terminate().catch(() => 0));
    }
    this.slots.clear();
    this.idle.length = 0;
    await Promise.all(terminations);
    this.phase = 'stopped';
  }
}

let pool: EquityWorkerPool | null = null;

/** Process-wide shared equity pool. GameServer starts it before opening routes. */
export function getEquityPool(): EquityWorkerPool {
  if (!pool) pool = new EquityWorkerPool();
  return pool;
}

export async function startEquityWorkerPool(): Promise<EquityWorkerPoolStatus> {
  return getEquityPool().ready();
}

export function equityWorkerPoolStatus(): EquityWorkerPoolStatus {
  return (
    pool?.status() ?? {
      phase: 'idle',
      routingReady: false,
      acceptingWork: false,
      recoveryInFlight: false,
      configuredWorkers: 0,
      readyWorkers: 0,
      busyWorkers: 0,
      queueDepth: 0,
      oldestQueuedAgeMs: 0,
      lastCompletionAgeMs: null,
      lastError: null,
    }
  );
}

export async function stopEquityWorkerPool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.shutdown();
}
