/**
 * Main-thread client for the isolated Horse League compute worker.
 *
 * There is deliberately no synchronous fallback. If the worker cannot boot,
 * hydrate the solver corpus, answer heartbeats, or return a valid response,
 * the analysis run fails closed and its durable claim can be retried. Falling
 * back to HorseLogic on the live event loop would recreate the outage this
 * boundary exists to prevent.
 */

import { Worker } from 'node:worker_threads';

import { liveHorseDecisionWorkerStatus } from '../engine/horseDecision/client.js';
import type { LeagueMatchup, LeagueResult } from './HorseLeague.js';
import type { AgreementResult } from './HorseSolverAgreement.js';
import type {
  HorseLeagueComputeRequest,
  HorseLeagueComputeResponse,
  SolverStoreCounts,
} from './HorseLeagueComputeProtocol.js';

const READY_TIMEOUT_MS = 60_000;
const JOB_HEARTBEAT_TIMEOUT_MS = 30_000;
const CANCEL_POLL_MS = 250;

interface WorkerLike {
  postMessage(message: HorseLeagueComputeRequest): void;
  on(event: 'message', listener: (message: HorseLeagueComputeResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
  unref?(): void;
}

export interface HorseLeagueComputeWorkerClientOptions {
  /** Defaults to the compiled worker next to this file. */
  workerFactory?: () => WorkerLike;
  /** Production default is true. Tests may use a self-contained fake worker. */
  hydrateSolverStores?: boolean;
  /** Snapshot of the live stores that the worker is not allowed to underfill. */
  expectedSolverStores?: SolverStoreCounts;
  readyTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  cancelPollMs?: number;
}

interface PendingJob<T> {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  heartbeatTimer: ReturnType<typeof setTimeout>;
  cancelTimer: ReturnType<typeof setInterval> | null;
}

export interface HorseLeagueCompute {
  ready(): Promise<SolverStoreCounts>;
  scoreSolverAgreement(maxSpots?: number): Promise<AgreementResult>;
  runMatchup(
    matchup: LeagueMatchup,
    pairs: number,
    runSeed: number,
    shouldContinue?: () => boolean
  ): Promise<LeagueResult>;
  shutdown(): Promise<void>;
}

function defaultWorkerFactory(hydrateSolverStores: boolean): () => WorkerLike {
  return () =>
    new Worker(new URL('./HorseLeagueComputeWorker.js', import.meta.url), {
      workerData: { hydrateSolverStores },
    }) as WorkerLike;
}

function currentSolverStores(): SolverStoreCounts {
  const live = liveHorseDecisionWorkerStatus();
  if (live.phase !== 'ready' || !live.solverStores) {
    throw new Error(
      `horse league cannot establish the live solver corpus while the decision worker is ${live.phase}`
    );
  }
  return { ...live.solverStores };
}

export class HorseLeagueComputeWorkerClient implements HorseLeagueCompute {
  private readonly worker: WorkerLike;
  private readonly expectedSolverStores: SolverStoreCounts;
  private readonly heartbeatTimeoutMs: number;
  private readonly cancelPollMs: number;
  private readonly readyPromise: Promise<SolverStoreCounts>;
  private resolveReady!: (counts: SolverStoreCounts) => void;
  private rejectReady!: (error: Error) => void;
  private readyTimer: ReturnType<typeof setTimeout>;
  private nextJobId = 1;
  private pending: { jobId: number; job: PendingJob<unknown> } | null = null;
  private closed = false;

  constructor(options: HorseLeagueComputeWorkerClientOptions = {}) {
    const hydrateSolverStores = options.hydrateSolverStores !== false;
    this.expectedSolverStores = options.expectedSolverStores ?? currentSolverStores();
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? JOB_HEARTBEAT_TIMEOUT_MS;
    this.cancelPollMs = options.cancelPollMs ?? CANCEL_POLL_MS;
    this.readyPromise = new Promise<SolverStoreCounts>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = (options.workerFactory ?? defaultWorkerFactory(hydrateSolverStores))();
    this.worker.on('message', (message) => this.onMessage(message));
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.closed)
        this.fail(new Error(`horse league compute worker exited with code ${code}`));
    });
    this.worker.unref?.();
    this.readyTimer = setTimeout(
      () => this.fail(new Error('horse league compute worker readiness timed out')),
      options.readyTimeoutMs ?? READY_TIMEOUT_MS
    );
    this.readyTimer.unref?.();
  }

  ready(): Promise<SolverStoreCounts> {
    return this.readyPromise;
  }

  scoreSolverAgreement(maxSpots?: number): Promise<AgreementResult> {
    return this.dispatch<AgreementResult>({ type: 'SCORE_SOLVER_AGREEMENT', maxSpots });
  }

  runMatchup(
    matchup: LeagueMatchup,
    pairs: number,
    runSeed: number,
    shouldContinue: () => boolean = () => true
  ): Promise<LeagueResult> {
    return this.dispatch<LeagueResult>(
      { type: 'RUN_MATCHUP', matchup, pairs, runSeed },
      shouldContinue
    );
  }

  private async dispatch<T>(
    command:
      | Omit<Extract<HorseLeagueComputeRequest, { type: 'RUN_MATCHUP' }>, 'jobId'>
      | Omit<Extract<HorseLeagueComputeRequest, { type: 'SCORE_SOLVER_AGREEMENT' }>, 'jobId'>,
    shouldContinue?: () => boolean
  ): Promise<T> {
    await this.readyPromise;
    if (this.closed) throw new Error('horse league compute worker is closed');
    if (this.pending) {
      throw new Error(`horse league compute worker already owns job ${this.pending.jobId}`);
    }
    const jobId = this.nextJobId++;
    return new Promise<T>((resolve, reject) => {
      const heartbeatTimer = setTimeout(
        () => this.fail(new Error(`horse league compute worker job ${jobId} stopped heartbeating`)),
        this.heartbeatTimeoutMs
      );
      heartbeatTimer.unref?.();
      const cancelTimer = shouldContinue
        ? setInterval(() => {
            if (!shouldContinue()) this.worker.postMessage({ type: 'CANCEL', jobId });
          }, this.cancelPollMs)
        : null;
      cancelTimer?.unref?.();
      this.pending = {
        jobId,
        job: {
          resolve: resolve as (value: unknown) => void,
          reject,
          heartbeatTimer,
          cancelTimer,
        },
      };
      this.worker.postMessage({ ...command, jobId } as HorseLeagueComputeRequest);
    });
  }

  private onMessage(message: HorseLeagueComputeResponse): void {
    if (message.type === 'READY') {
      clearTimeout(this.readyTimer);
      const missing = (
        Object.keys(this.expectedSolverStores) as Array<keyof SolverStoreCounts>
      ).filter((key) => message.solverStores[key] < this.expectedSolverStores[key]);
      if (missing.length > 0) {
        this.fail(
          new Error(
            `horse league compute worker solver stores are incomplete: ${missing
              .map(
                (key) =>
                  `${key}=${message.solverStores[key]} expected>=${this.expectedSolverStores[key]}`
              )
              .join(', ')}`
          )
        );
        return;
      }
      this.resolveReady(message.solverStores);
      return;
    }

    if (message.type === 'ERROR') {
      this.fail(new Error(message.message));
      return;
    }

    const pending = this.pending;
    if (!pending || pending.jobId !== message.jobId) {
      this.fail(
        new Error(`horse league compute worker returned an unexpected job ${message.jobId}`)
      );
      return;
    }
    clearTimeout(pending.job.heartbeatTimer);
    if (message.type === 'HEARTBEAT') {
      pending.job.heartbeatTimer = setTimeout(
        () =>
          this.fail(
            new Error(`horse league compute worker job ${message.jobId} stopped heartbeating`)
          ),
        this.heartbeatTimeoutMs
      );
      pending.job.heartbeatTimer.unref?.();
      return;
    }

    if (pending.job.cancelTimer) clearInterval(pending.job.cancelTimer);
    this.pending = null;
    pending.job.resolve(message.result);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    clearTimeout(this.readyTimer);
    this.rejectReady(error);
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.job.heartbeatTimer);
      if (pending.job.cancelTimer) clearInterval(pending.job.cancelTimer);
      pending.job.reject(error);
    }
    void this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.job.heartbeatTimer);
      if (pending.job.cancelTimer) clearInterval(pending.job.cancelTimer);
      pending.job.reject(new Error('horse league compute worker shut down'));
    }
    await this.worker.terminate();
  }
}
