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

/**
 * ── A QUEUE WAIT IS NOT A STUCK WORKER, AND A SPENT POOL IS NOT A DEAD ONE (2026-09-11) ──
 *
 * At 06:57-07:00 UTC this pool went 'failed' in production and stayed there:
 * live all-in equity and all-in insurance pricing (real money) were gone for
 * the rest of the process's life. An engine restart had just thawed 955
 * tables into a tournament catch-up surge - 1,927 tournament hands in two
 * minutes, about 15x normal - and /health settled on
 *
 *   {"phase":"failed","configuredWorkers":1,"readyWorkers":0,
 *    "lastError":"Equity worker operation timed out after 2500ms"}
 *
 * with 5,267 EquityWorkerUnavailableError and 1,628 EquityWorkerTimeoutError
 * in the first three minutes and ~160 failures a minute from then on. The
 * previous five-hour process had 38 timeouts and never failed.
 *
 * Nothing was wrong with the worker. The host has three cores, so the pool
 * is ONE worker (availableParallelism() - 2). Each job's only timer was armed
 * at ENQUEUE, so its wait in the queue was charged against it. In a burst the
 * job at the head reached the worker with a few milliseconds left and "timed
 * out" while ACTIVE; the timeout handler took that for a wedged worker,
 * terminated the healthy, busy worker and scheduled a respawn; the
 * replacement took the next aged job off the same queue and timed out the
 * same way. Ten respawns without a completion spent the respawn budget, which
 * only a completion refills, scheduleRespawn wrote 'failed', and nothing ever
 * spawned a worker again.
 *
 * Fail-closed is unchanged: an operation that cannot be answered in time is
 * rejected, and the event loop never computes it instead. What changed:
 *
 * TWO BUDGETS, EACH MEASURED WHERE IT MEANS SOMETHING.
 *   queue      jobTimeoutMs from enqueue. A job no worker started in time is
 *              taken out of the queue and rejected with EquityWorkerTimeoutError
 *              (stage 'queue'). That is load shedding, not a fault: it touches
 *              no worker, spends no respawn budget, and is counted in
 *              status().queueExpirations instead of overwriting lastError.
 *   execution  jobTimeoutMs from dispatch (postMessage). Only this deadline
 *              can mean the worker is stuck, so only it retires the worker -
 *              after one poll turn of grace, so an answer that already arrived
 *              while the main thread was busy is read before the worker is
 *              condemned.
 *   A caller waits at most 2 x jobTimeoutMs, and in practice its queue wait
 *   plus milliseconds of compute. A dispatched job always gets its whole
 *   execution budget, so in a burst the worker only computes answers somebody
 *   is still waiting for. Insurance still goes ahead of cosmetic equity in the
 *   queue, exactly as before.
 *
 * A SPENT BUDGET STARTS A COOLDOWN, NOT A FUNERAL. When respawns run out the
 *   pool reports 'failed' (no workers left) or 'degraded' (some left). With
 *   none left it refuses new work at once and fails what is queued; with some
 *   left they keep serving. After the cooldown it refills its budget and
 *   spawns again. The cooldown starts at 30 s and doubles up to 5 minutes
 *   while recoveries end without a completion; the first completion resets
 *   it. status().nextRecoveryAt and recoveries put it on /health. A
 *   replacement worker must author READY within readyTimeoutMs or it is
 *   retired too, so a hung boot cannot hold a recovery hostage either.
 */
const DEFAULT_JOB_TIMEOUT_MS = 2_500;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const RESPAWN_DELAY_MS = 250;
const DEFAULT_RESPAWN_BUDGET = 10;
const DEFAULT_RECOVERY_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_RECOVERY_COOLDOWN_MS = 300_000;

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
  configuredWorkers: number;
  readyWorkers: number;
  busyWorkers: number;
  queueDepth: number;
  oldestQueuedAgeMs: number;
  lastCompletionAgeMs: number | null;
  lastError: string | null;
  /** Operations no worker started inside the queue budget. No worker was touched. */
  queueExpirations: number;
  /** Operations that outran the execution budget after dispatch; each retired its worker. */
  executionTimeouts: number;
  /** Respawns left before the pool has to cool down. Every completion refills it. */
  respawnBudgetRemaining: number;
  /** Epoch ms at which a spent pool refills its budget and spawns again; null if none pending. */
  nextRecoveryAt: number | null;
  /** Cooldown recoveries this pool has started. */
  recoveries: number;
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

/** Where an operation ran out of time: waiting for a worker, or on one. */
export type EquityWorkerTimeoutStage = 'queue' | 'execution';

export class EquityWorkerTimeoutError extends EquityWorkerUnavailableError {
  readonly stage: EquityWorkerTimeoutStage;

  constructor(timeoutMs: number, stage: EquityWorkerTimeoutStage = 'execution') {
    // Both messages keep the pre-2026-09-11 prefix, so a search for the old
    // text still finds them; the suffix says which budget ran out.
    super(
      stage === 'queue'
        ? `Equity worker operation timed out after ${timeoutMs}ms waiting in the queue; no worker was touched`
        : `Equity worker operation timed out after ${timeoutMs}ms of worker execution`
    );
    this.name = 'EquityWorkerTimeoutError';
    this.stage = stage;
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
  /** Queue budget: armed at enqueue, cleared at dispatch. It can never touch a worker. */
  queueTimer?: ReturnType<typeof setTimeout>;
  /** Execution budget: armed at dispatch. The only deadline that retires a worker. */
  executionTimer?: ReturnType<typeof setTimeout>;
  /** One poll turn for an answer already waiting on the port when the execution budget ends. */
  executionGrace?: ReturnType<typeof setImmediate>;
  settled: boolean;
}

interface WorkerSlot {
  worker: WorkerLike;
  ready: boolean;
  down: boolean;
  job?: Job;
  /** READY deadline of a replacement worker. ready() bounds the first boot instead. */
  readyTimer?: ReturnType<typeof setTimeout>;
}

export interface EquityWorkerPoolOptions {
  size?: number;
  disabled?: boolean;
  workerFactory?: () => WorkerLike;
  readyTimeoutMs?: number;
  /** The queue budget from enqueue and, separately, the execution budget from dispatch. */
  jobTimeoutMs?: number;
  respawnBudget?: number;
  /** First cooldown once the respawn budget is spent; doubles per recovery without a completion. */
  recoveryCooldownMs?: number;
  /** Ceiling of the doubling cooldown. */
  maxRecoveryCooldownMs?: number;
}

export class EquityWorkerPool {
  private readonly size: number;
  private readonly disabled: boolean;
  private readonly workerFactory: () => WorkerLike;
  private readonly readyTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly maxRespawnBudget: number;
  private respawnBudget: number;
  private phase: EquityWorkerPoolPhase = 'idle';
  private readonly slots = new Set<WorkerSlot>();
  private readonly idle: WorkerSlot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private pendingRespawns = 0;
  private hasReachedReady = false;
  private lastCompletedAt: number | null = null;
  private lastError: string | null = null;
  private readinessPromise: Promise<EquityWorkerPoolStatus> | null = null;
  private resolveReadiness: ((status: EquityWorkerPoolStatus) => void) | null = null;
  private rejectReadiness: ((error: Error) => void) | null = null;
  private readinessTimer?: ReturnType<typeof setTimeout>;
  private readonly respawnTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly baseRecoveryCooldownMs: number;
  private readonly maxRecoveryCooldownMs: number;
  private recoveryCooldownMs: number;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private nextRecoveryAt: number | null = null;
  private recoveries = 0;
  private queueExpirations = 0;
  private executionTimeouts = 0;

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
    this.maxRespawnBudget = Math.max(0, options.respawnBudget ?? DEFAULT_RESPAWN_BUDGET);
    this.respawnBudget = this.maxRespawnBudget;
    this.baseRecoveryCooldownMs = Math.max(
      1,
      options.recoveryCooldownMs ?? DEFAULT_RECOVERY_COOLDOWN_MS
    );
    this.maxRecoveryCooldownMs = Math.max(
      this.baseRecoveryCooldownMs,
      options.maxRecoveryCooldownMs ?? DEFAULT_MAX_RECOVERY_COOLDOWN_MS
    );
    this.recoveryCooldownMs = this.baseRecoveryCooldownMs;
  }

  status(): EquityWorkerPoolStatus {
    const now = Date.now();
    const readyWorkers = [...this.slots].filter((slot) => slot.ready && !slot.down).length;
    const busyWorkers = [...this.slots].filter((slot) => slot.job && !slot.down).length;
    return {
      phase: this.phase,
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
      queueExpirations: this.queueExpirations,
      executionTimeouts: this.executionTimeouts,
      respawnBudgetRemaining: this.respawnBudget,
      nextRecoveryAt: this.nextRecoveryAt,
      recoveries: this.recoveries,
    };
  }

  isAvailable(): boolean {
    const status = this.status();
    return (status.phase === 'ready' || status.phase === 'degraded') && status.readyWorkers > 0;
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
      this.lastError = error.message;
      this.phase = 'failed';
      this.rejectReadiness?.(error);
      this.clearReadinessWaiters();
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
    if (this.phase !== 'ready' && this.phase !== 'degraded') {
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
      // The QUEUE budget only (2026-09-11, top of file). This timer can reject
      // a job that no worker started in time; it can never touch a worker.
      // Dispatch clears it and arms the execution budget in its place.
      job.queueTimer = setTimeout(() => this.onQueueDeadline(job), this.jobTimeoutMs);
      job.queueTimer.unref?.();
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

  private spawnWorker(): void {
    if (this.phase === 'stopping' || this.phase === 'stopped' || this.disabled) return;
    let worker: WorkerLike;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this.lastError = this.errorMessage(error);
      this.scheduleRespawn();
      return;
    }
    const slot: WorkerSlot = { worker, ready: false, down: false };
    this.slots.add(slot);
    worker.on('message', (message) => this.onMessage(slot, message));
    worker.on('error', (error) => this.onWorkerDown(slot, error));
    worker.on('exit', (code) => this.onWorkerDown(slot, new Error(`Equity worker exited ${code}`)));
    worker.unref?.();
    // ready() bounds the first boot and fails the engine's start if it hangs.
    // A replacement (respawn or recovery) has no such caller, so it carries
    // its own READY deadline: a boot that hangs is retired and retried through
    // the same budget and cooldown instead of holding its slot forever.
    if (this.phase !== 'starting') {
      slot.readyTimer = setTimeout(() => this.onReadyDeadline(slot), this.readyTimeoutMs);
      slot.readyTimer.unref?.();
    }
  }

  private onReadyDeadline(slot: WorkerSlot): void {
    slot.readyTimer = undefined;
    if (slot.down || slot.ready) return;
    this.retireWorker(
      slot,
      new EquityWorkerUnavailableError(
        `Equity worker did not become ready within ${this.readyTimeoutMs}ms`
      )
    );
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
      if (slot.readyTimer) clearTimeout(slot.readyTimer);
      slot.readyTimer = undefined;
      if (!slot.ready) {
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
        // A completion is the proof a recovery worked: the next spent budget
        // cools down from the base again instead of the backed-off length.
        this.recoveryCooldownMs = this.baseRecoveryCooldownMs;
      } catch (error) {
        this.rejectJob(job, new EquityWorkerUnavailableError(this.errorMessage(error)));
        this.retireWorker(slot, error);
        return;
      }
    }
    if (!slot.down && this.slots.has(slot)) this.idle.push(slot);
    this.pump();
  }

  /**
   * No worker started this job inside its queue budget. Shed it and nothing
   * else: the worker that is busy is busy with somebody else's answer, and
   * retiring it for this job's wait is exactly what killed the pool on
   * 2026-09-11. Shedding is not a fault either, so it is counted in
   * queueExpirations and leaves lastError naming the last real one.
   */
  private onQueueDeadline(job: Job): void {
    job.queueTimer = undefined;
    if (job.settled) return;
    const queueIndex = this.queue.indexOf(job);
    // Already dispatched: its execution budget owns it now.
    if (queueIndex < 0) return;
    this.queue.splice(queueIndex, 1);
    this.queueExpirations += 1;
    this.rejectJob(job, new EquityWorkerTimeoutError(this.jobTimeoutMs, 'queue'));
  }

  /** A dispatched job outran its execution budget: the only sign a worker is stuck. */
  private onExecutionDeadline(slot: WorkerSlot, job: Job): void {
    job.executionTimer = undefined;
    if (job.settled || slot.down || slot.job !== job) return;
    // Timers run before the poll phase that delivers worker messages. After a
    // long main-thread stall the answer may already be waiting on the port,
    // and a worker that answered is not stuck. Look again after one poll turn
    // (the same grace the live horse client gives its worker) and retire only
    // a worker that is still silent.
    job.executionGrace = setImmediate(() => {
      job.executionGrace = undefined;
      if (job.settled || slot.down || slot.job !== job) return;
      const error = new EquityWorkerTimeoutError(this.jobTimeoutMs, 'execution');
      this.executionTimeouts += 1;
      this.lastError = error.message;
      this.rejectJob(job, error);
      this.retireWorker(slot, error);
    });
    job.executionGrace.unref?.();
  }

  private pump(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const slot = this.idle.pop()!;
      if (slot.down || !slot.ready || slot.job) continue;
      const job = this.queue.shift()!;
      // The queue budget ends here and the execution budget starts here, so
      // no wait in the queue can ever be charged to the worker.
      if (job.queueTimer) clearTimeout(job.queueTimer);
      job.queueTimer = undefined;
      slot.job = job;
      job.executionTimer = setTimeout(() => this.onExecutionDeadline(slot, job), this.jobTimeoutMs);
      job.executionTimer.unref?.();
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
    if (slot.readyTimer) clearTimeout(slot.readyTimer);
    slot.readyTimer = undefined;
    this.lastError = this.errorMessage(reason);
    this.slots.delete(slot);
    const idleIndex = this.idle.indexOf(slot);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    if (slot.job) {
      this.rejectJob(slot.job, new EquityWorkerUnavailableError(this.lastError));
      slot.job = undefined;
    }
    if (this.phase !== 'starting') this.phase = 'degraded';
    void slot.worker.terminate().catch(() => {});
    this.scheduleRespawn();
  }

  private onWorkerDown(slot: WorkerSlot, reason: unknown): void {
    this.retireWorker(slot, reason);
  }

  private scheduleRespawn(): void {
    if (this.phase === 'stopping' || this.phase === 'stopped') return;
    if (this.slots.size + this.pendingRespawns >= this.size) return;
    if (this.respawnBudget <= 0) {
      if (this.hasReachedReady && this.slots.size === 0 && this.pendingRespawns === 0) {
        this.phase = 'failed';
        // No worker can exist again before the cooldown ends, so nothing
        // queued can be answered: fail it now rather than at its deadline.
        const error = new EquityWorkerUnavailableError(
          'Equity worker pool spent its respawn budget and is cooling down'
        );
        for (const job of this.queue.splice(0)) this.rejectJob(job, error);
      }
      // Until 2026-09-11 this was the end of the pool: 'failed' with nothing
      // left that would ever spawn a worker. Now it is a cooldown.
      this.scheduleRecovery();
      return;
    }
    this.respawnBudget -= 1;
    this.pendingRespawns += 1;
    const timer = setTimeout(() => {
      this.respawnTimers.delete(timer);
      this.pendingRespawns -= 1;
      this.spawnWorker();
    }, RESPAWN_DELAY_MS);
    timer.unref?.();
    this.respawnTimers.add(timer);
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer || this.phase === 'stopping' || this.phase === 'stopped') return;
    const cooldownMs = this.recoveryCooldownMs;
    this.nextRecoveryAt = Date.now() + cooldownMs;
    this.recoveryTimer = setTimeout(() => this.recover(), cooldownMs);
    this.recoveryTimer.unref?.();
  }

  /** The cooldown is over: refill the budget and bring the pool back to size. */
  private recover(): void {
    this.recoveryTimer = undefined;
    this.nextRecoveryAt = null;
    if (this.phase === 'stopping' || this.phase === 'stopped') return;
    this.recoveries += 1;
    // Back off while recoveries keep ending without a completion, so a worker
    // that cannot survive costs at most one recovery (a spawn plus a refilled
    // respawn budget) per 5 minutes instead of a crash loop. The first
    // completion puts the cooldown back to its base.
    this.recoveryCooldownMs = Math.min(this.maxRecoveryCooldownMs, this.recoveryCooldownMs * 2);
    this.respawnBudget = this.maxRespawnBudget;
    const missing = this.size - this.slots.size - this.pendingRespawns;
    for (let i = 0; i < missing; i++) this.spawnWorker();
  }

  private updatePhaseAfterCapacityChange(): void {
    const readyWorkers = [...this.slots].filter((slot) => slot.ready && !slot.down).length;
    if (readyWorkers === this.size) {
      this.hasReachedReady = true;
      this.phase = 'ready';
      this.resolveReadiness?.(this.status());
      this.clearReadinessWaiters();
    } else if (this.phase !== 'starting') {
      this.phase = readyWorkers > 0 ? 'degraded' : 'failed';
    }
  }

  private resolveJob<T>(job: Job<T>, result: T): void {
    if (job.settled) return;
    job.settled = true;
    this.clearJobTimers(job);
    job.resolve(result);
  }

  private rejectJob(job: Job, error: Error): void {
    if (job.settled) return;
    job.settled = true;
    this.clearJobTimers(job);
    job.reject(error);
  }

  private clearJobTimers(job: Job): void {
    if (job.queueTimer) clearTimeout(job.queueTimer);
    job.queueTimer = undefined;
    if (job.executionTimer) clearTimeout(job.executionTimer);
    job.executionTimer = undefined;
    if (job.executionGrace) clearImmediate(job.executionGrace);
    job.executionGrace = undefined;
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
    // Nothing this pool armed may outlive it: a pending recovery or respawn
    // would otherwise spawn a worker into a pool that has been stopped.
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.nextRecoveryAt = null;
    for (const timer of this.respawnTimers) clearTimeout(timer);
    this.respawnTimers.clear();
    this.pendingRespawns = 0;
    const aborted = new EquityWorkerPoolAbortedError();
    this.rejectReadiness?.(aborted);
    this.clearReadinessWaiters();
    for (const job of this.queue.splice(0)) this.rejectJob(job, aborted);
    const terminations: Promise<number>[] = [];
    for (const slot of this.slots) {
      slot.down = true;
      if (slot.readyTimer) clearTimeout(slot.readyTimer);
      slot.readyTimer = undefined;
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
      configuredWorkers: 0,
      readyWorkers: 0,
      busyWorkers: 0,
      queueDepth: 0,
      oldestQueuedAgeMs: 0,
      lastCompletionAgeMs: null,
      lastError: null,
      queueExpirations: 0,
      executionTimeouts: 0,
      respawnBudgetRemaining: 0,
      nextRecoveryAt: null,
      recoveries: 0,
    }
  );
}

export async function stopEquityWorkerPool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.shutdown();
}
