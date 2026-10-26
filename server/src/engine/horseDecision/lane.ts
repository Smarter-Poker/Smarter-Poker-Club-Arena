import { readHorseOwnPublicHistory } from '../../services/HorseOwnPublicHistory.js';
import { HorseObserverParticipantRegistry } from './observerParticipants.js';
import { availableParallelism } from 'node:os';
import {
  isHorseSolverStoreIdentity,
  sameSolverStoreIdentity,
} from '../../gto/SolverStoreIdentity.js';
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
import { decisionWorkersCanYield } from './workerPriority.js';
import { horseDecisionShard } from './shard.js';
import {
  horseJournalCapacityUnreadableReason,
  horseJournalShardCapacity,
  horseJournalShardCapacityMeasured,
} from '../../services/horseDecisionJournal/config.js';
import type { HorsePlanAcceptance } from '../HorsePlanEffectReceipt.js';

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
 * WHAT CHANGED, AND IS STATED HERE RATHER THAN DISCOVERED LATER: HorseMind's
 * live opponent statistics are in-process and per worker. A worker only sees
 * the action streams of the tables it serves, so until 2026-10-16 each held
 * the lifetime counters hydrated from horse_mind_stats at boot plus what its
 * own tables taught it, and two horses facing the same player on different
 * shards held different reads of that player.
 *
 * ONE FLOOR, ONE READ (2026-10-16). Every completed hand now reaches every
 * shard: the owner observes and journals it as before, and each other shard
 * learns it from the same accepted action stream (client.mirrorCompletedHand,
 * mindMirror.ts). A shard learns another table's hand in an isolated HorseMind
 * sandbox and adds exactly that hand's counters to its live memory, so the
 * dedupe and hand flags of its own hands in flight are never displaced by the
 * rest of the floor's traffic. The mirror is bounded per client, and the
 * GREATEST-merged flush stays correct: every shard's counters now count the
 * same hands, so any shard's flush is the floor's.
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
 * more than two by default where a worker cannot yield (where it can, see
 * 2026-10-12 below). HORSE_DECISION_WORKERS raises it explicitly for
 * an operator who knows the host, still capped by availableParallelism() - 2
 * (one context for the main loop, one for an equity worker).
 *
 * THE SECOND WORKER ON A TWO-CORE HOST IS ADMITTED ONLY WHERE IT YIELDS
 * (2026-09-26, later). What the 08:19Z storm measured was not the database
 * (heartbeat_tournament_leases_v4: 47 ms mean, 4.6 s max through it) but the
 * main thread losing the CPU to two best-effort threads. workerPriority.ts
 * now has every decision worker lower itself to nice 10 on Linux before it
 * loads a solver store, so the kernel hands the main loop the core whenever
 * both want it. On such a platform a two-core host runs two workers again:
 * the horses think, and the lease renewal pass is never the thread that
 * waits. Anywhere the worker cannot yield, the physical-core rule stands.
 *
 * WHERE THE WORKERS YIELD, THE DEFAULT FOLLOWS THE PHYSICAL CORES, BOUNDED BY
 * THE JOURNAL'S DISK (2026-10-12). The engine host is now a KVM guest with
 * eight logical CPUs on four EPYC Milan cores. Measured read-only
 * there (Prometheus 15-minute means, /health, top -H, the private journal):
 *
 *     both decision workers (nice 10)          99% CPU each at every peak
 *     host                                     4.5 of 8 logical CPUs idle
 *     lane oldest queued job, 1,500-1,700      2-4 s (Oct 11 21:00Z to
 *       horses seated                            Oct 12 04:00Z, before #6700)
 *     the same at 2,070 horses (Oct 12 05:22Z) 5.8-7.4 s, 450-510 queued
 *     at 600-950 horses (07:00-11:00Z)         under 0.2 s, 1-3 queued
 *
 * The queue followed the floor, not a release: it was 140-257 deep with the
 * oldest job 2-4 s before release 9d567463 at the same load, and per-decision
 * worker CPU did not rise with it (journal sample of 16,267 decisions,
 * 09:25-11:25Z: 18.7 ms a decision, of which the Phase 7 tournament utility
 * 60%, the reference brain 27%, the joint owner 8.6%; the October 11 daily
 * means were 20.4 ms, 63%, 26% and 9%). Two threads were the ceiling while
 * half the host idled. So where the workers yield, the default is one worker
 * per physical core but one (which the main loop, the equity pool and the
 * journal writers keep), never fewer than the two it has always run: three
 * on this host, still two on a two-core host and on six logical CPUs.
 *
 * ONE YIELDING WORKER PER PHYSICAL CORE (2026-10-16). Every horse decides
 * with the full brain now (workerRuntime.ts, "THE WORKER DECIDES WITH THE
 * QUALIFIED BRAIN"), so the lane must carry the qualified sample at the
 * floor's peak instead of shedding it. Measured read-only on the engine host
 * on 2026-10-16 (release 4c3509e5, 18:40-18:55Z, 379 tables, 200 tournaments):
 *
 *     three decision workers (nice 10)        81-95% CPU each
 *     main loop                                79% of a core, p50 delay 20 ms
 *     HorseLeagueComputeProcess (nice 19)      96% of a core (the 16:00 window)
 *     host                                     load 8.8 on 8 logical CPUs,
 *                                              17-21% idle
 *     decisions                                72 a second, 2.14 worker-seconds
 *                                              of compute a second
 *     request -> journal                       p50 371 ms, p90 2.4 s, p99 3.4 s
 *
 * The main loop needs most of one core and every other live thread is
 * small, so the default is one decision worker per physical core where they
 * yield (four on this host, eight on sixteen logical CPUs), still bounded by
 * logical CPUs less two and by the journal's disk below. Where they cannot
 * yield, the two-worker rule above stands. Nothing about this host's count
 * changes until the journal's disk admits the fourth shard: on the 80 GB disk
 * it reads three (see horseJournalShardCapacity), which is the measured
 * reason the engine host needs its disk upgraded with its plan.
 *
 * Shards 0/1 retain 8 GiB of segments; new shards 2+ default to 4 GiB
 * (runtimeHorseJournalArchiveOptions), each with a 6 GiB catalog ceiling. A default that added
 * shards the disk cannot hold would fill the host, so the default never
 * exceeds horseJournalShardCapacity: existing shards' remaining growth is
 * charged before new worst-case allocations, with a reserve left over. The
 * 2026-10-12 host reading (23,377,231,872 bytes free; existing archives
 * 13,881,448 and 13,479,580 KiB) admits the third 11 GiB shard after
 * charging 6,342,045,696 bytes of existing growth and a 4 GiB reserve. An explicit
 * HORSE_DECISION_WORKERS is the operator's call and is not bounded by it.
 */
export const HORSE_DECISION_WORKERS_ENV = 'HORSE_DECISION_WORKERS';
export const DEFAULT_HORSE_DECISION_WORKERS = 2;
export const MAX_HORSE_DECISION_WORKERS = 8;

/** Logical CPUs per physical core assumed when nothing says otherwise. */
export const ASSUMED_THREADS_PER_CORE = 2;

export function horseDecisionWorkerCount(input: {
  requested?: string | number | null | undefined;
  cores: number;
  /** Whether a worker can lower its own thread priority (workerPriority.ts). */
  canYield?: boolean;
  /** The most worker shards whose journal archives the journal's filesystem
   * can hold (horseJournalShardCapacity); absent when nothing is journaled.
   * Bounds the default only. */
  journalShards?: number;
}): number {
  const logical = Number.isSafeInteger(input.cores) && input.cores > 0 ? input.cores : 1;
  // An explicit request may use every logical CPU but the main loop's and one
  // equity worker's. Where the workers yield, the default is one per physical
  // core (2026-10-16), never fewer than two; where they cannot, it leaves a
  // whole physical core for the main loop and stays at two at most.
  const explicitCapacity = Math.max(1, logical - 2);
  const physical = Math.max(1, Math.floor(logical / ASSUMED_THREADS_PER_CORE));
  const cpuDefault = input.canYield
    ? Math.min(Math.max(DEFAULT_HORSE_DECISION_WORKERS, physical), explicitCapacity)
    : Math.min(DEFAULT_HORSE_DECISION_WORKERS, physical - 1);
  const journalShards =
    typeof input.journalShards === 'number' &&
    Number.isSafeInteger(input.journalShards) &&
    input.journalShards >= 1
      ? input.journalShards
      : MAX_HORSE_DECISION_WORKERS;
  const defaultCount = Math.max(1, Math.min(cpuDefault, journalShards, MAX_HORSE_DECISION_WORKERS));
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

export { horseDecisionShard };

export interface LiveHorseDecisionWorkerShardStatus {
  index: number;
  phase: LiveHorseDecisionWorkerPhase;
  queueDepth: number;
  inFlightJobs: number;
  completedJobs: number;
  expiredJobs: number;
  oldestQueuedAgeMs: number | null;
  oldestQueuedDecisionAgeMs: number | null;
  lastComputeMs: number | null;
  lastError: string | null;
}

export interface LiveHorseDecisionLaneStatus extends LiveHorseDecisionWorkerStatus {
  workerCount: number;
  /** The journal shards the disk admitted at construction (null: no journal). */
  journalShardCapacity: number | null;
  /** Why that reading was refused (the two-worker ceiling), else null. */
  journalCapacityUnreadable: string | null;
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
  commitDecisionEffects(
    result: FastHorseDecisionResult,
    acceptance: HorsePlanAcceptance
  ): Promise<HorseDecisionWorkerAck>;
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
  /** The journal capacity measured before construction off the event loop
   * (horseJournalShardCapacityMeasured); absent, the constructor reads it. */
  journalCapacity?: { shards: number | undefined };
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
  private readonly observerParticipants = new HorseObserverParticipantRegistry();
  private readonly clients: readonly LiveHorseDecisionWorkerClient[];
  private readonly readyPromise: Promise<HorseDecisionWorkerReadiness>;
  /** The journal shards the disk can hold, read once at construction. */
  readonly journalShardCapacity: number | undefined;
  /** Why the capacity reading was refused, read once with it. */
  readonly journalCapacityUnreadable: string | null;

  constructor(options: LiveHorseDecisionLaneOptions = {}) {
    this.journalShardCapacity = options.journalCapacity
      ? options.journalCapacity.shards
      : horseJournalShardCapacity();
    this.journalCapacityUnreadable = horseJournalCapacityUnreadableReason();
    const count = horseDecisionWorkerCount({
      requested: options.workers ?? process.env[HORSE_DECISION_WORKERS_ENV],
      cores: availableParallelism(),
      canYield: decisionWorkersCanYield(),
      journalShards: this.journalShardCapacity,
    });
    const clientOptions: LiveHorseDecisionWorkerClientOptions = {
      ...options,
      ownPublicHistory:
        options.ownPublicHistory ?? (options.workerFactory ? undefined : readHorseOwnPublicHistory),
    };
    delete (clientOptions as LiveHorseDecisionLaneOptions).workers;
    delete (clientOptions as LiveHorseDecisionLaneOptions).journalCapacity;
    this.clients = Object.freeze(
      Array.from(
        { length: count },
        (_, index) =>
          new LiveHorseDecisionWorkerClient({ ...clientOptions, shard: { index, count } })
      )
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
    const sameCorpus = (r: HorseDecisionWorkerReadiness): boolean => {
      const a = first.solverStoreIdentity;
      const b = r.solverStoreIdentity;
      // Preserve legacy handshakes without identity, but never equate a missing
      // or malformed identity to a genuinely loaded content-addressed corpus.
      if (a === undefined && b === undefined) return true;
      return (
        isHorseSolverStoreIdentity(a) &&
        isHorseSolverStoreIdentity(b) &&
        sameSolverStoreIdentity(a.charts, b.charts) &&
        sameSolverStoreIdentity(a.postflop, b.postflop)
      );
    };
    const divergent = readiness.findIndex((r) => identity(r) !== expected || !sameCorpus(r));
    if (divergent >= 0) {
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
      oldestQueuedDecisionAgeMs: maxOf(all.map((s) => s.oldestQueuedDecisionAgeMs)),
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
      journalShardCapacity: this.journalShardCapacity ?? null,
      journalCapacityUnreadable: this.journalCapacityUnreadable,
      workers: all.map((s, index) => ({
        index,
        phase: s.phase,
        queueDepth: s.queueDepth,
        inFlightJobs: s.inFlightJobs,
        completedJobs: s.completedJobs,
        expiredJobs: s.expiredJobs,
        oldestQueuedAgeMs: s.oldestQueuedAgeMs,
        oldestQueuedDecisionAgeMs: s.oldestQueuedDecisionAgeMs,
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
    const original = structuredClone(snapshot);
    return this.shard(original.fence)
      .decideFast(original, signal, options)
      .then((result) => {
        // Only the validated original FAST can register this observer. A rejected
        // or never-delivered decision cannot enroll another horse in a hand.
        this.observerParticipants.capture(original);
        return result;
      });
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
    // The owner journals the hand. Other shards receive public completion
    // only for the same original observer's already-existing private view;
    // the pool supplies admission from validated original FASTs.
    const original = {
      ...observation,
      observerParticipants: this.observerParticipants.take(observation),
    };
    const owner = horseDecisionShard(original.fence, this.clients.length);
    const ack = this.clients[owner]!.observeCompletedHand(original, signal);
    for (let index = 0; index < this.clients.length; index++)
      if (index !== owner) this.clients[index]!.mirrorCompletedHand(original);
    return ack;
  }

  commitDecisionEffects(
    result: FastHorseDecisionResult,
    acceptance: HorsePlanAcceptance
  ): Promise<HorseDecisionWorkerAck> {
    // The result's fence is its request's fence, so this is the client that
    // issued the plan and holds its ownership.
    return this.shard(result.fence).commitDecisionEffects(result, acceptance);
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
    // The archive walk runs as a child process the event loop does not wait
    // on (horseJournalShardCapacityMeasured, 2026-10-15).
    const journalCapacity = options.journalCapacity ?? {
      shards: await horseJournalShardCapacityMeasured(process.env, {
        sufficientShards: MAX_HORSE_DECISION_WORKERS,
      }),
    };
    if (!singleton) singleton = new LiveHorseDecisionWorkerPool({ ...options, journalCapacity });
    console.log(
      `[LiveHorseDecisionWorker] ${singleton.workerCount} decision worker(s) sharded by table ` +
        `on ${availableParallelism()} logical CPU(s)` +
        (singleton.journalShardCapacity === undefined
          ? ''
          : `, journal disk ceiling ${singleton.journalShardCapacity} shard(s)`) +
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
  oldestQueuedDecisionAgeMs: null,
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
  journalShardCapacity: null,
  journalCapacityUnreadable: null,
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
