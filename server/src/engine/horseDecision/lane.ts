import { availableParallelism } from 'node:os';
import {
  LiveHorseDecisionWorkerClient,
  type HorseDecisionJobOptions,
  type LiveHorseDecisionWorkerClientOptions,
  type LiveHorseDecisionWorkerPhase,
  type LiveHorseDecisionWorkerStatus,
} from './client.js';
import type {
  CompletedHandObservation,
  DeepHorseDecisionResult,
  FastHorseDecisionResult,
  HorseDecisionWorkerAck,
  HorseDecisionWorkerReadiness,
  LiveHorseDecisionSnapshot,
  PineappleDiscardResult,
  PineappleDiscardSnapshot,
} from './protocol.js';
import type { HorseDiscardExecutionObservation } from '../../services/horseDecisionJournal/discard.js';

/**
 * THE DECISION LANE IS SHARDED BY TABLE (2026-09-26).
 *
 * One HorseLogic worker served every table. Its throughput is one core's
 * worth of `HorseLogic.decide` (13 ms a decision on engine-01 with the floor
 * idle, 26-50 ms with it full), which is about 25 decisions a second.
 *
 * Measured on engine-01 on 2026-09-26, once the stall fixes had put the fleet
 * back on the floor (85 dealing tables at 01:53 UTC, 450-790 from 02:08):
 *
 *     poker_horse_decision_worker_queue_depth            566 .. 986
 *     poker_horse_decision_worker_oldest_queued_age_ms   7,400 .. 13,500
 *     rate(poker_horse_decision_worker_expired_jobs)     40 .. 68 a second
 *     /health.liveHorseDecision   completedJobs 40,221  expiredJobs 53,652
 *                                 (the first 29 minutes of build b4ff9bb8)
 *
 * Fifty-seven percent of every decision the fleet asked for expired in the
 * queue before the worker reached it, and an expired decision is a seat
 * taking the legal check or fold without thinking. The eight days before
 * that, at 85 tables, the same series read 0. The hand-gap on one NLH cash
 * table went from a p50 of 30-45 s (p90 60-80 s) to 80-160 s (p90 180-570 s),
 * which is why the fleet could no longer finish its last hands inside the
 * two-minute announcement window and why the post-deploy live-table
 * certificate stopped observing a hand cycle inside its 90 s budget.
 *
 * So the lane is now N workers, and every job for one table goes to the same
 * worker. The shard key is the table id, which every fence in this protocol
 * begins with (ServerTableEngineTurns, ServerTableEngineRunout and
 * handHistory all build `fence` as `${tableId}:...`), so:
 *   - FIFO order per table is unchanged: a table's FAST, its COMMIT, its
 *     RETIRE and its completed-hand observation queue behind each other
 *     exactly as they did with one worker;
 *   - the RNG is per request (workerRuntime restores `rngBefore` from the
 *     canonical decision key before every decide), so a decision does not
 *     depend on which worker computes it;
 *   - plan ownership (client.planOwners) is per client, and a commit is routed
 *     by the result's own fence, which is the request's fence.
 *
 * WHAT CHANGES, AND IS STATED HERE RATHER THAN DISCOVERED LATER: HorseMind's
 * live opponent statistics are in-process and per worker. A worker only sees
 * the action streams of the tables it serves, so with two workers each holds
 * the lifetime counters hydrated from horse_mind_stats at boot plus what its
 * own tables taught it; the GREATEST-merged flush keeps the database
 * monotonic and each worker learns from about half the floor instead of all
 * of it. That is the trade against 57% of decisions being no decision at all.
 *
 * WHAT DOES NOT CHANGE: no replacement worker, no respawn. Any worker's loss
 * is process-fatal exactly as the sole worker's was (see client.ts), and the
 * dispatch barrier one table holds across its synchronous performAction is
 * held on every shard, so it can only be stricter than before.
 *
 * THE COUNT IS A CAPACITY POLICY, MEASURED TWICE (2026-09-26).
 *
 * The first cut ran two workers on any host with four or more logical CPUs.
 * engine-01 reports four, but they are two EPYC Milan cores with SMT, and at
 * 780-880 dealing tables the second worker showed what that means:
 *
 *     poker_horse_decision_fallbacks_total     0.0 /s from 07:15Z (24-31 /s before)
 *     lane oldest queued job                   3-6 s        (12-13.5 s before)
 *     fleet                                    830-940 hands/min (680-945)
 *     poker_event_loop_delay_p50_ms            300-650      (20 before)
 *     host                                     95-100% busy
 *     poker_tournament_managers_quarantined    0 -> 27 in 30 minutes
 *
 * The horses thought, and the main thread paid for it: the tournament lease
 * renewal pass missed its 20 s proof window in the two storms it met (07:10
 * and 07:35Z, "lease generation expired before it was renewed"), 27 managers
 * were quarantined, their terminal engines answered stopped_bank_custody_
 * unwritten at the next break, and that held the restart certificate shut
 * for every release. A brain that thinks on a host that then drops leases is
 * not a better engine.
 *
 * So the default counts PHYSICAL cores, which Node cannot see, by the only
 * safe assumption for a cloud host: two threads per core. One worker until
 * the host has three physical cores (six logical), two from there, never
 * more than two by default. HORSE_DECISION_WORKERS raises it explicitly for
 * an operator who knows the host, still capped by availableParallelism() - 2
 * (one context for the main loop, one for an equity worker). On engine-01
 * that is one worker until the floor is capped to what two cores can think
 * for, or the engine moves to a larger host.
 */
export const HORSE_DECISION_WORKERS_ENV = 'HORSE_DECISION_WORKERS';
export const DEFAULT_HORSE_DECISION_WORKERS = 2;
export const MAX_HORSE_DECISION_WORKERS = 8;

/** Logical CPUs per physical core assumed when nothing says otherwise. */
export const ASSUMED_THREADS_PER_CORE = 2;

export function horseDecisionWorkerCount(input: {
  requested?: string | number | null | undefined;
  cores: number;
}): number {
  const logical = Number.isSafeInteger(input.cores) && input.cores > 0 ? input.cores : 1;
  // An explicit request may use every logical CPU but the main loop's and one
  // equity worker's; the default leaves a whole physical core for them.
  const explicitCapacity = Math.max(1, logical - 2);
  const physical = Math.max(1, Math.floor(logical / ASSUMED_THREADS_PER_CORE));
  const defaultCount = Math.max(1, Math.min(DEFAULT_HORSE_DECISION_WORKERS, physical - 1));
  const raw =
    typeof input.requested === 'number'
      ? input.requested
      : typeof input.requested === 'string' && /^\d+$/.test(input.requested.trim())
        ? Number(input.requested.trim())
        : NaN;
  if (Number.isSafeInteger(raw) && raw >= 1 && raw <= MAX_HORSE_DECISION_WORKERS) {
    return Math.max(1, Math.min(explicitCapacity, raw));
  }
  return defaultCount;
}

/** FNV-1a over the fence's table id. Stable across processes and restarts. */
export function horseDecisionShard(fence: string, workers: number): number {
  if (!Number.isSafeInteger(workers) || workers <= 1) return 0;
  const colon = fence.indexOf(':');
  const key = colon > 0 ? fence.slice(0, colon) : fence;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % workers;
}

export interface LiveHorseDecisionWorkerShardStatus {
  index: number;
  phase: LiveHorseDecisionWorkerPhase;
  queueDepth: number;
  inFlightJobs: number;
  completedJobs: number;
  expiredJobs: number;
  oldestQueuedAgeMs: number | null;
  lastComputeMs: number | null;
  lastError: string | null;
}

export interface LiveHorseDecisionLaneStatus extends LiveHorseDecisionWorkerStatus {
  workerCount: number;
  workers: LiveHorseDecisionWorkerShardStatus[];
}

/** The public surface every caller uses; the sole client and the lane both offer it. */
export interface LiveHorseDecisionLane {
  ready(): Promise<HorseDecisionWorkerReadiness>;
  status(): LiveHorseDecisionLaneStatus;
  decideFast(
    snapshot: LiveHorseDecisionSnapshot,
    signal?: AbortSignal,
    options?: HorseDecisionJobOptions
  ): Promise<FastHorseDecisionResult>;
  decideDeep(
    snapshot: LiveHorseDecisionSnapshot & { rngBefore: number; deepEquity: number },
    signal?: AbortSignal,
    options?: HorseDecisionJobOptions
  ): Promise<DeepHorseDecisionResult>;
  observeCompletedHand(
    observation: CompletedHandObservation,
    signal?: AbortSignal
  ): Promise<HorseDecisionWorkerAck>;
  commitDecisionEffects(result: FastHorseDecisionResult): Promise<HorseDecisionWorkerAck>;
  decideDiscard(
    snapshot: PineappleDiscardSnapshot,
    signal?: AbortSignal
  ): Promise<PineappleDiscardResult>;
  observeDiscardExecution(execution: HorseDiscardExecutionObservation): void;
  runWithDispatchBarrier<T>(fn: () => T): T;
  stop(): Promise<void>;
}

export interface LiveHorseDecisionLaneOptions extends LiveHorseDecisionWorkerClientOptions {
  /** Tests pin the count; production derives it (horseDecisionWorkerCount). */
  workers?: number;
}

const PHASE_RANK: Record<LiveHorseDecisionWorkerPhase, number> = {
  failed: 4,
  stopping: 3,
  starting: 2,
  stopped: 1,
  ready: 0,
};

const maxOf = (values: Array<number | null>): number | null =>
  values.reduce<number | null>(
    (max, v) => (v === null ? max : max === null || v > max ? v : max),
    null
  );
const minOf = (values: Array<number | null>): number | null =>
  values.reduce<number | null>(
    (min, v) => (v === null ? min : min === null || v < min ? v : min),
    null
  );
const sumOf = (values: number[]): number => values.reduce((a, b) => a + b, 0);

export class LiveHorseDecisionWorkerPool implements LiveHorseDecisionLane {
  private readonly clients: readonly LiveHorseDecisionWorkerClient[];
  private readonly readyPromise: Promise<HorseDecisionWorkerReadiness>;

  constructor(options: LiveHorseDecisionLaneOptions = {}) {
    const count = horseDecisionWorkerCount({
      requested: options.workers ?? process.env[HORSE_DECISION_WORKERS_ENV],
      cores: availableParallelism(),
    });
    const clientOptions: LiveHorseDecisionWorkerClientOptions = { ...options };
    delete (clientOptions as LiveHorseDecisionLaneOptions).workers;
    this.clients = Object.freeze(
      Array.from({ length: count }, () => new LiveHorseDecisionWorkerClient(clientOptions))
    );
    this.readyPromise = this.awaitAllReady();
    void this.readyPromise.catch(() => undefined);
  }

  get workerCount(): number {
    return this.clients.length;
  }

  private shard(fence: string): LiveHorseDecisionWorkerClient {
    return this.clients[horseDecisionShard(fence, this.clients.length)]!;
  }

  private async awaitAllReady(): Promise<HorseDecisionWorkerReadiness> {
    const readiness = await Promise.all(this.clients.map((client) => client.ready()));
    const first = readiness[0]!;
    const identity = (r: HorseDecisionWorkerReadiness): string =>
      JSON.stringify([
        r.solverStores,
        r.solverPolicyArtifact.policyVersion,
        r.solverPolicyArtifact.schemaSha256,
        r.solverPolicyArtifact.totalPolicies,
      ]);
    const expected = identity(first);
    const divergent = readiness.findIndex((r) => identity(r) !== expected);
    if (divergent > 0) {
      // Two brains with different corpora would make a table's play depend on
      // its shard. Refuse readiness; GameServer treats that as a boot failure
      // and stops the lane, which joins these already-started stops.
      void Promise.allSettled(this.clients.map((client) => client.stop()));
      throw new Error(
        `live horse decision worker ${divergent} loaded a different solver corpus than worker 0`
      );
    }
    return first;
  }

  ready(): Promise<HorseDecisionWorkerReadiness> {
    return this.readyPromise;
  }

  status(): LiveHorseDecisionLaneStatus {
    const all = this.clients.map((client) => client.status());
    const first = all[0]!;
    const phase = all.reduce<LiveHorseDecisionWorkerPhase>(
      (worst, s) => (PHASE_RANK[s.phase] > PHASE_RANK[worst] ? s.phase : worst),
      first.phase
    );
    const latest = all.reduce((best, s) =>
      s.lastCompletedAt !== null &&
      (best.lastCompletedAt === null || s.lastCompletedAt > best.lastCompletedAt)
        ? s
        : best
    );
    const lastExpired = all.reduce((best, s) =>
      s.lastExpiredAt !== null &&
      (best.lastExpiredAt === null || s.lastExpiredAt > best.lastExpiredAt)
        ? s
        : best
    );
    const lastRecoverable = all.reduce((best, s) =>
      s.lastRecoverableRequestErrorAt !== null &&
      (best.lastRecoverableRequestErrorAt === null ||
        s.lastRecoverableRequestErrorAt > best.lastRecoverableRequestErrorAt)
        ? s
        : best
    );
    const governors = all.map((s) => s.governor).filter((g) => g !== null);
    // The most throttled worker is the one the alerts must see.
    const governor =
      governors.length === 0
        ? null
        : governors.reduce((worst, g) => (g.scale < worst.scale ? g : worst));
    return {
      phase,
      startedAt: minOf(all.map((s) => s.startedAt)),
      readyAt: all.every((s) => s.readyAt !== null) ? maxOf(all.map((s) => s.readyAt)) : null,
      maxInFlight: sumOf(all.map((s) => s.maxInFlight)),
      queueDepth: sumOf(all.map((s) => s.queueDepth)),
      inFlightJobs: sumOf(all.map((s) => s.inFlightJobs)),
      activeRequestId: first.activeRequestId,
      activeJobAgeMs: maxOf(all.map((s) => s.activeJobAgeMs)),
      oldestQueuedAgeMs: maxOf(all.map((s) => s.oldestQueuedAgeMs)),
      lastCompletedAt: latest.lastCompletedAt,
      lastComputeMs: latest.lastComputeMs,
      completedJobs: sumOf(all.map((s) => s.completedJobs)),
      expiredJobs: sumOf(all.map((s) => s.expiredJobs)),
      lastExpiredAt: lastExpired.lastExpiredAt,
      lastExpiredRequestType: lastExpired.lastExpiredRequestType,
      lastExpiredPhase: lastExpired.lastExpiredPhase,
      recoverableRequestErrors: sumOf(all.map((s) => s.recoverableRequestErrors)),
      lastRecoverableRequestErrorAt: lastRecoverable.lastRecoverableRequestErrorAt,
      lastRecoverableRequestErrorType: lastRecoverable.lastRecoverableRequestErrorType,
      lastRecoverableRequestError: lastRecoverable.lastRecoverableRequestError,
      lastError: all.find((s) => s.lastError !== null)?.lastError ?? null,
      solverStores: first.solverStores,
      solverPolicyArtifact: first.solverPolicyArtifact,
      governor: governor ? { ...governor } : null,
      statusSampledAt: minOf(all.map((s) => s.statusSampledAt)),
      workerCount: all.length,
      workers: all.map((s, index) => ({
        index,
        phase: s.phase,
        queueDepth: s.queueDepth,
        inFlightJobs: s.inFlightJobs,
        completedJobs: s.completedJobs,
        expiredJobs: s.expiredJobs,
        oldestQueuedAgeMs: s.oldestQueuedAgeMs,
        lastComputeMs: s.lastComputeMs,
        lastError: s.lastError,
      })),
    };
  }

  decideFast(
    snapshot: LiveHorseDecisionSnapshot,
    signal?: AbortSignal,
    options?: HorseDecisionJobOptions
  ): Promise<FastHorseDecisionResult> {
    return this.shard(snapshot.fence).decideFast(snapshot, signal, options);
  }

  decideDeep(
    snapshot: LiveHorseDecisionSnapshot & { rngBefore: number; deepEquity: number },
    signal?: AbortSignal,
    options?: HorseDecisionJobOptions
  ): Promise<DeepHorseDecisionResult> {
    return this.shard(snapshot.fence).decideDeep(snapshot, signal, options);
  }

  observeCompletedHand(
    observation: CompletedHandObservation,
    signal?: AbortSignal
  ): Promise<HorseDecisionWorkerAck> {
    return this.shard(observation.fence).observeCompletedHand(observation, signal);
  }

  commitDecisionEffects(result: FastHorseDecisionResult): Promise<HorseDecisionWorkerAck> {
    // The result's fence is its request's fence, so this is the client that
    // issued the plan and holds its ownership.
    return this.shard(result.fence).commitDecisionEffects(result);
  }

  decideDiscard(
    snapshot: PineappleDiscardSnapshot,
    signal?: AbortSignal
  ): Promise<PineappleDiscardResult> {
    return this.shard(snapshot.fence).decideDiscard(snapshot, signal);
  }

  observeDiscardExecution(execution: HorseDiscardExecutionObservation): void {
    this.shard(execution.request.fence).observeDiscardExecution(execution);
  }

  runWithDispatchBarrier<T>(fn: () => T): T {
    // Nested barriers are supported by each client (a depth counter), so the
    // callback runs inside every shard's barrier at once.
    const run = (index: number): T =>
      index >= this.clients.length
        ? fn()
        : this.clients[index]!.runWithDispatchBarrier(() => run(index + 1));
    return run(0);
  }

  async stop(): Promise<void> {
    const outcomes = await Promise.allSettled(this.clients.map((client) => client.stop()));
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    if (failed) throw failed.reason;
  }
}

let singleton: LiveHorseDecisionWorkerPool | null = null;

export async function startLiveHorseDecisionWorker(
  options: LiveHorseDecisionLaneOptions = {}
): Promise<LiveHorseDecisionLane> {
  if (!singleton) {
    singleton = new LiveHorseDecisionWorkerPool(options);
    console.log(
      `[LiveHorseDecisionWorker] ${singleton.workerCount} decision worker(s) sharded by table ` +
        `on ${availableParallelism()} logical CPU(s)` +
        (process.env[HORSE_DECISION_WORKERS_ENV]
          ? ` (${HORSE_DECISION_WORKERS_ENV}=${process.env[HORSE_DECISION_WORKERS_ENV]})`
          : '')
    );
  }
  await singleton.ready();
  return singleton;
}

export function getLiveHorseDecisionWorker(): LiveHorseDecisionLane {
  if (!singleton) throw new Error('live horse decision worker has not been started');
  return singleton;
}

const stoppedLaneStatus = (): LiveHorseDecisionLaneStatus => ({
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
  workerCount: 0,
  workers: [],
});

export function liveHorseDecisionWorkerStatus(): LiveHorseDecisionLaneStatus {
  return singleton?.status() ?? stoppedLaneStatus();
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
