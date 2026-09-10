/**
 * Main-thread client for the isolated Horse League compute process.
 *
 * There is deliberately no synchronous fallback. If the worker cannot boot,
 * hydrate the solver corpus, answer heartbeats, or return a valid response,
 * the analysis run fails closed and its durable claim can be retried. Falling
 * back to HorseLogic on the live event loop would recreate the outage this
 * boundary exists to prevent.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';

import { liveHorseDecisionWorkerStatus } from '../engine/horseDecision/client.js';
import { horseDecisionSolverStoresAreValid } from '../engine/horseDecision/protocol.js';
import type { LeagueMatchup, LeagueResult } from './HorseLeague.js';
import type { AgreementResult } from './HorseSolverAgreement.js';
import type { GtoV31AgreementResult } from './HorseSolverAgreementV31.js';
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
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
  unref?(): void;
}

class LowPriorityComputeProcess implements WorkerLike {
  constructor(private readonly child: ChildProcess) {}

  postMessage(message: HorseLeagueComputeRequest): void {
    if (!this.child.connected) {
      throw new Error('horse league compute process IPC is closed');
    }
    this.child.send(message);
  }

  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(
    event: 'message' | 'error' | 'exit',
    listener: ((message: unknown) => void) | ((error: Error) => void) | ((code: number) => void)
  ): this {
    if (event === 'message') {
      this.child.on('message', (message) => (listener as (value: unknown) => void)(message));
    } else if (event === 'error') {
      this.child.on('error', listener as (error: Error) => void);
    } else {
      this.child.on('exit', (code) => (listener as (value: number) => void)(code ?? 1));
    }
    return this;
  }

  terminate(): Promise<number> {
    if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode);
    return new Promise<number>((resolve) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve(code ?? 0);
      };
      this.child.once('exit', finish);
      this.child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill('SIGKILL');
      }, 5_000);
      killTimer.unref?.();
    });
  }

  unref(): void {
    // Keep the IPC child referenced so shutdown can join its actual exit.
    // The engine lifecycle explicitly terminates this process in finally.
  }
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
  resultType: 'MATCHUP_RESULT' | 'AGREEMENT_RESULT' | 'GTO_V31_AGREEMENT_RESULT';
  heartbeatTimer: ReturnType<typeof setTimeout>;
  cancelTimer: ReturnType<typeof setInterval> | null;
}

export interface HorseLeagueCompute {
  ready(): Promise<SolverStoreCounts>;
  scoreSolverAgreement(maxSpots?: number): Promise<AgreementResult>;
  scoreGtoV31Agreement(
    maxSpots?: number,
    shouldContinue?: () => boolean
  ): Promise<GtoV31AgreementResult>;
  runMatchup(
    matchup: LeagueMatchup,
    pairs: number,
    runSeed: number,
    shouldContinue?: () => boolean
  ): Promise<LeagueResult>;
  shutdown(): Promise<void>;
}

function defaultWorkerFactory(hydrateSolverStores: boolean): () => WorkerLike {
  return () => {
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const childExecArgv: string[] = [];
    for (let i = 0; i < process.execArgv.length; i++) {
      const arg = process.execArgv[i];
      if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print') {
        i += 1;
        continue;
      }
      if (arg === '--input-type') {
        i += 1;
        continue;
      }
      if (arg.startsWith('--input-type=')) continue;
      childExecArgv.push(arg);
    }
    const child = fork(
      fileURLToPath(new URL(`./HorseLeagueComputeProcess${extension}`, import.meta.url)),
      [],
      {
        execArgv: childExecArgv,
        env: {
          ...process.env,
          HORSE_LEAGUE_HYDRATE_SOLVER_STORES: hydrateSolverStores ? '1' : '0',
        },
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      }
    );
    return new LowPriorityComputeProcess(child);
  };
}

function currentSolverStores(): SolverStoreCounts {
  const live = liveHorseDecisionWorkerStatus();
  if (live.phase !== 'ready' || !live.solverStores) {
    throw new Error(
      `horse league cannot establish the live solver corpus while the decision worker is ${live.phase}`
    );
  }
  assertV31StoreIdentity(live.solverStores, 'live horse decision worker');
  return structuredClone(live.solverStores);
}

function assertV31StoreIdentity(stores: SolverStoreCounts, owner: string): void {
  if (!horseDecisionSolverStoresAreValid(stores)) {
    throw new Error(`${owner} cannot prove a valid solver-store snapshot and V31 identity`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isJobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteNumber(value: unknown, minimum = -Infinity, maximum = Infinity): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function isLeagueBenchmarkComponent(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'scenario',
      'hands',
      'bb100',
      'stderr',
      'durationMs',
      'illegalActions',
      'truncatedStreets',
      'candidatePolicyHits',
      'candidateExecutionMismatches',
      'candidateNodeRoles',
    ])
  )
    return false;
  return (
    typeof value.scenario === 'string' &&
    value.scenario.length > 0 &&
    isNonnegativeSafeInteger(value.hands) &&
    isFiniteNumber(value.bb100) &&
    isFiniteNumber(value.stderr, 0) &&
    isFiniteNumber(value.durationMs, 0) &&
    isNonnegativeSafeInteger(value.illegalActions) &&
    isNonnegativeSafeInteger(value.truncatedStreets) &&
    isNonnegativeSafeInteger(value.candidatePolicyHits) &&
    isNonnegativeSafeInteger(value.candidateExecutionMismatches) &&
    isStringArray(value.candidateNodeRoles)
  );
}

function isLeagueResult(value: unknown): value is LeagueResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'matchup',
      'hands',
      'bb100',
      'stderr',
      'durationMs',
      'illegalActions',
      'truncatedStreets',
      'candidatePolicyHits',
      'candidateExecutionMismatches',
      'candidateNodeRoles',
      'benchmarkComponents',
    ])
  )
    return false;
  return (
    typeof value.matchup === 'string' &&
    value.matchup.length > 0 &&
    isNonnegativeSafeInteger(value.hands) &&
    isFiniteNumber(value.bb100) &&
    isFiniteNumber(value.stderr, 0) &&
    isFiniteNumber(value.durationMs, 0) &&
    isNonnegativeSafeInteger(value.illegalActions) &&
    isNonnegativeSafeInteger(value.truncatedStreets) &&
    isNonnegativeSafeInteger(value.candidatePolicyHits) &&
    isNonnegativeSafeInteger(value.candidateExecutionMismatches) &&
    isStringArray(value.candidateNodeRoles) &&
    Array.isArray(value.benchmarkComponents) &&
    value.benchmarkComponents.every(isLeagueBenchmarkComponent)
  );
}

function hasAgreementDecisionShape(value: unknown, v31: boolean): boolean {
  if (!isRecord(value) || !isRecord(value.decisionState) || !isRecord(value.sourceSeal)) {
    return false;
  }
  const common = [
    'stateKey',
    'decisionState',
    'finalAction',
    'referenceDistribution',
    'chosenProbability',
    'actionRegretBb',
    'regretEligible',
    'pureMiss',
    'sourceSeal',
  ];
  const expected = v31
    ? [
        ...common,
        'stage',
        'gameFamily',
        'objective',
        'utilityContext',
        'tableSize',
        'potType',
        'heroPosition',
        'opponentPosition',
        'depthBucket',
        'textureClass',
        'nodeRole',
        'facingKind',
        'facingSizeBucket',
        'cell',
        'handKey',
        'sampledActionId',
        'sampledActionFamily',
        'executedAsIntended',
      ]
    : [...common, 'kind', 'gameType', 'position', 'stackBb', 'hand'];
  if (!hasExactKeys(value, expected)) return false;
  const distribution = value.referenceDistribution;
  if (!isRecord(distribution)) return false;
  const probabilities = Object.values(distribution);
  return (
    typeof value.stateKey === 'string' &&
    value.stateKey.length > 0 &&
    typeof value.finalAction === 'string' &&
    value.finalAction.length > 0 &&
    probabilities.length >= 2 &&
    probabilities.every((item) => isFiniteNumber(item, 0, 1)) &&
    Math.abs(probabilities.reduce((sum, item) => sum + (item as number), 0) - 1) <= 0.002 &&
    isFiniteNumber(value.chosenProbability, 0, 1) &&
    (value.actionRegretBb === null || isFiniteNumber(value.actionRegretBb, 0)) &&
    typeof value.regretEligible === 'boolean' &&
    typeof value.pureMiss === 'boolean' &&
    (!v31 || typeof value.executedAsIntended === 'boolean')
  );
}

function isAgreementResult(
  value: unknown,
  reference: 'gto_charts' | 'gto_v31_certified'
): value is AgreementResult | GtoV31AgreementResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'spots',
      'agreement',
      'pureMisses',
      'reference',
      'eligibleSpots',
      'reconciledSpots',
      'actionRegretBb',
      'regretEligibleSpots',
      'decisionChecksum',
      'decisions',
    ])
  )
    return false;
  if (
    !isNonnegativeSafeInteger(value.spots) ||
    !isFiniteNumber(value.agreement, 0, 1) ||
    !isNonnegativeSafeInteger(value.pureMisses) ||
    !isNonnegativeSafeInteger(value.eligibleSpots) ||
    !isNonnegativeSafeInteger(value.reconciledSpots) ||
    !isNonnegativeSafeInteger(value.regretEligibleSpots) ||
    (value.actionRegretBb !== null && !isFiniteNumber(value.actionRegretBb, 0)) ||
    !Array.isArray(value.decisions)
  )
    return false;
  if (value.reference === null) {
    return (
      value.spots === 0 &&
      value.agreement === 0 &&
      value.pureMisses === 0 &&
      value.eligibleSpots === 0 &&
      value.reconciledSpots === 0 &&
      value.regretEligibleSpots === 0 &&
      value.actionRegretBb === null &&
      value.decisionChecksum === null &&
      value.decisions.length === 0
    );
  }
  return (
    value.reference === reference &&
    value.spots > 0 &&
    value.spots === value.eligibleSpots &&
    value.spots === value.reconciledSpots &&
    value.spots === value.decisions.length &&
    value.pureMisses <= value.spots &&
    value.regretEligibleSpots <= value.spots &&
    value.regretEligibleSpots > 0 === (value.actionRegretBb !== null) &&
    typeof value.decisionChecksum === 'string' &&
    /^[0-9a-f]{64}$/.test(value.decisionChecksum) &&
    value.decisionChecksum !== '0'.repeat(64) &&
    value.decisions.every((decision) =>
      hasAgreementDecisionShape(decision, reference === 'gto_v31_certified')
    )
  );
}

/** Runtime guard for the child-process structured-clone boundary. */
function horseLeagueComputeResponseIsValid(value: unknown): value is HorseLeagueComputeResponse {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'READY':
      return (
        (hasExactKeys(value, ['type', 'solverStores']) ||
          hasExactKeys(value, ['type', 'solverStores', 'executionNice'])) &&
        isRecord(value.solverStores) &&
        (value.executionNice === undefined || Number.isSafeInteger(value.executionNice))
      );
    case 'HEARTBEAT':
      return hasExactKeys(value, ['type', 'jobId']) && isJobId(value.jobId);
    case 'MATCHUP_RESULT':
      return (
        hasExactKeys(value, ['type', 'jobId', 'result']) &&
        isJobId(value.jobId) &&
        isLeagueResult(value.result)
      );
    case 'AGREEMENT_RESULT':
      return (
        hasExactKeys(value, ['type', 'jobId', 'result']) &&
        isJobId(value.jobId) &&
        isAgreementResult(value.result, 'gto_charts')
      );
    case 'GTO_V31_AGREEMENT_RESULT':
      return (
        hasExactKeys(value, ['type', 'jobId', 'result']) &&
        isJobId(value.jobId) &&
        isAgreementResult(value.result, 'gto_v31_certified')
      );
    case 'ERROR':
      return (
        hasExactKeys(value, ['type', 'jobId', 'message']) &&
        (value.jobId === null || isJobId(value.jobId)) &&
        typeof value.message === 'string' &&
        value.message.length > 0
      );
    default:
      return false;
  }
}

export class HorseLeagueComputeWorkerClient implements HorseLeagueCompute {
  private readonly worker: WorkerLike;
  private readonly expectedSolverStores: SolverStoreCounts;
  private readonly heartbeatTimeoutMs: number;
  private readonly cancelPollMs: number;
  private readonly requireLowPriorityProcess: boolean;
  private readonly readyPromise: Promise<SolverStoreCounts>;
  private resolveReady!: (counts: SolverStoreCounts) => void;
  private rejectReady!: (error: Error) => void;
  private readyTimer: ReturnType<typeof setTimeout>;
  private nextJobId = 1;
  private pending: { jobId: number; job: PendingJob<unknown> } | null = null;
  private readyReceived = false;
  private closed = false;

  constructor(options: HorseLeagueComputeWorkerClientOptions = {}) {
    const hydrateSolverStores = options.hydrateSolverStores !== false;
    this.expectedSolverStores = options.expectedSolverStores ?? currentSolverStores();
    assertV31StoreIdentity(this.expectedSolverStores, 'expected live horse decision worker');
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? JOB_HEARTBEAT_TIMEOUT_MS;
    this.cancelPollMs = options.cancelPollMs ?? CANCEL_POLL_MS;
    this.requireLowPriorityProcess = options.workerFactory === undefined;
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

  scoreGtoV31Agreement(
    maxSpots?: number,
    shouldContinue: () => boolean = () => true
  ): Promise<GtoV31AgreementResult> {
    return this.dispatch<GtoV31AgreementResult>(
      { type: 'SCORE_GTO_V31_AGREEMENT', maxSpots },
      shouldContinue
    );
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
      | Omit<Extract<HorseLeagueComputeRequest, { type: 'SCORE_SOLVER_AGREEMENT' }>, 'jobId'>
      | Omit<Extract<HorseLeagueComputeRequest, { type: 'SCORE_GTO_V31_AGREEMENT' }>, 'jobId'>,
    shouldContinue?: () => boolean
  ): Promise<T> {
    await this.readyPromise;
    if (this.closed) throw new Error('horse league compute worker is closed');
    if (this.pending) {
      throw new Error(`horse league compute worker already owns job ${this.pending.jobId}`);
    }
    const jobId = this.nextJobId++;
    const resultType =
      command.type === 'RUN_MATCHUP'
        ? 'MATCHUP_RESULT'
        : command.type === 'SCORE_SOLVER_AGREEMENT'
          ? 'AGREEMENT_RESULT'
          : 'GTO_V31_AGREEMENT_RESULT';
    return new Promise<T>((resolve, reject) => {
      const heartbeatTimer = setTimeout(
        () => this.fail(new Error(`horse league compute worker job ${jobId} stopped heartbeating`)),
        this.heartbeatTimeoutMs
      );
      heartbeatTimer.unref?.();
      const cancelTimer = shouldContinue
        ? setInterval(() => {
            if (!shouldContinue()) {
              try {
                this.worker.postMessage({ type: 'CANCEL', jobId });
              } catch (error) {
                this.fail(
                  error instanceof Error
                    ? error
                    : new Error('horse league compute worker cancellation failed')
                );
              }
            }
          }, this.cancelPollMs)
        : null;
      cancelTimer?.unref?.();
      this.pending = {
        jobId,
        job: {
          resolve: resolve as (value: unknown) => void,
          reject,
          resultType,
          heartbeatTimer,
          cancelTimer,
        },
      };
      try {
        this.worker.postMessage({ ...command, jobId } as HorseLeagueComputeRequest);
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error('horse league compute worker dispatch failed')
        );
      }
    });
  }

  private onMessage(value: unknown): void {
    if (!horseLeagueComputeResponseIsValid(value)) {
      this.fail(new Error('horse league compute worker returned a malformed IPC response'));
      return;
    }
    const message = value;
    if (message.type === 'READY') {
      if (this.readyReceived) {
        this.fail(new Error('horse league compute worker returned duplicate READY'));
        return;
      }
      clearTimeout(this.readyTimer);
      if (
        this.requireLowPriorityProcess &&
        message.executionNice !== osConstants.priority.PRIORITY_LOW
      ) {
        this.fail(
          new Error(
            `horse league compute process started at nice ${String(message.executionNice)}; expected ${osConstants.priority.PRIORITY_LOW}`
          )
        );
        return;
      }
      try {
        assertV31StoreIdentity(message.solverStores, 'horse league compute worker');
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const countKeys = ['charts', 'postflop'] as const;
      const missing = countKeys.filter(
        (key) => message.solverStores[key] < this.expectedSolverStores[key]
      );
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
      const expectedDataset = this.expectedSolverStores.postflopV31Dataset;
      const actualDataset = message.solverStores.postflopV31Dataset;
      if (
        message.solverStores.postflopV31 !== this.expectedSolverStores.postflopV31 ||
        actualDataset?.id !== expectedDataset?.id ||
        actualDataset?.checksum !== expectedDataset?.checksum
      ) {
        this.fail(
          new Error(
            'horse league compute worker V31 corpus does not exactly match the live decision worker'
          )
        );
        return;
      }
      this.readyReceived = true;
      this.resolveReady(structuredClone(message.solverStores));
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

    if (message.type !== pending.job.resultType) {
      this.fail(
        new Error(
          `horse league compute worker returned ${message.type} for a ${pending.job.resultType} job`
        )
      );
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
