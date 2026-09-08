/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ShardManager — process-model abstraction for engine workers
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The control plane. It owns a pool of engine workers, decides which worker owns
 * each table (via TableRouter), health-checks them, and — critically — performs
 * a **graceful DRAIN**: tell a worker to finish its in-flight hands, hand every
 * table it owned to a surviving worker, then terminate it. Graceful drain is the
 * single primitive that makes blue-green / rolling zero-downtime deploys
 * possible (bring up new workers, drain old ones hand-by-hand, no player is
 * kicked mid-hand).
 *
 * Two axes of abstraction:
 *
 *   1. `ShardManager` (interface) vs `InProcessShardManager` (impl). The impl
 *      here manages workers ON ONE NODE. A future `MultiNodeShardManager` would
 *      implement the same interface but place workers across nodes and use a
 *      CrossNodeBus + a shared store (Redis/NATS) to agree on ownership — see
 *      the seam notes at the bottom of this file.
 *
 *   2. `WorkerFactory` (interface) vs `NodeWorkerFactory` (real worker_threads)
 *      vs `InlineWorkerFactory` (in-process, for tests / zero-thread fallback).
 *      The manager only talks to the `WorkerChannel` abstraction, so it is
 *      identical regardless of whether a worker is a real thread or an object.
 *
 * Standalone: depends only on sibling scale/* modules and node built-ins.
 */

import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { TableRouter } from './TableRouter.js';
import type {
  ManagerToWorker,
  WorkerToManager,
  WorkerId,
  WorkerGeneration,
  OwnershipEpoch,
  TableId,
  TableLease,
  TableCloseFailure,
  ShardWorkerData,
} from './protocol.js';
import { ShardWorkerRuntime, NoopTableHost, type TableHost } from './ShardWorkerRuntime.js';

export type { TableHost } from './ShardWorkerRuntime.js';

export type WorkerStatus = 'starting' | 'ready' | 'draining' | 'unhealthy' | 'stopped';

export interface WorkerHealth {
  workerId: WorkerId;
  workerGeneration: WorkerGeneration;
  status: WorkerStatus;
  tableCount: number;
  tables: TableId[];
  inflightHands: number;
  lastHeartbeatAt: number;
}

export interface Reassignment {
  tableId: TableId;
  from: WorkerId;
  to: WorkerId | null;
}

export interface DrainResult {
  workerId: WorkerId;
  completed: boolean;
  reassigned: Reassignment[];
  closedTables: TableId[];
  failedTables: TableCloseFailure[];
  durationMs: number;
  timedOut: boolean;
}

export class DrainFailedError extends Error {
  constructor(readonly result: DrainResult) {
    const suffix = result.timedOut
      ? 'timed out'
      : `${result.failedTables.length} table close${result.failedTables.length === 1 ? '' : 's'} failed`;
    super(`worker ${result.workerId} drain failed: ${suffix}`);
    this.name = 'DrainFailedError';
  }
}

export interface ShardManager {
  start(): Promise<void>;
  spawnWorker(id?: WorkerId): Promise<WorkerId>;
  assignTable(tableId: TableId): Promise<WorkerId>;
  unassignTable(tableId: TableId): Promise<void>;
  ownerOf(tableId: TableId): WorkerId | null;
  listWorkers(): WorkerHealth[];
  healthCheck(): Promise<WorkerHealth[]>;
  /** Graceful drain + handoff; returns what moved where. */
  drainWorker(workerId: WorkerId, opts?: { timeoutMs?: number }): Promise<DrainResult>;
  shutdown(): Promise<void>;
}

// ─── Worker channel / factory abstraction ────────────────────────────────────

export interface WorkerChannel {
  readonly id: WorkerId;
  postMessage(msg: ManagerToWorker): void;
  onMessage(cb: (msg: WorkerToManager) => void): void;
  onExit(cb: (code: number) => void): void;
  terminate(): Promise<void>;
}

export interface WorkerFactory {
  create(data: ShardWorkerData): WorkerChannel;
}

// ─── Control plane implementation ────────────────────────────────────────────

interface WorkerRecord {
  channel: WorkerChannel;
  generation: WorkerGeneration;
  status: WorkerStatus;
  tables: Map<TableId, OwnershipEpoch>;
  inflightHands: number;
  lastHeartbeatAt: number;
  pendingMutations: Set<Promise<void>>;
  fencePromise: Promise<boolean> | null;
  drainInFlight: boolean;
}

interface TableOwnership extends TableLease {
  workerId: WorkerId;
  workerGeneration: WorkerGeneration;
  state: 'assigning' | 'active';
}

export interface InProcessShardManagerOptions {
  factory: WorkerFactory;
  /** Heartbeat cadence pushed to each worker (ms). Default 2000. */
  heartbeatMs?: number;
  /** No heartbeat within this window → worker marked unhealthy (ms). Default 6000. */
  heartbeatTimeoutMs?: number;
  /** Default drain timeout (ms). Default 60000. */
  drainTimeoutMs?: number;
  /** Ack timeout for ASSIGN/UNASSIGN/READY/PONG (ms). Default 10000. */
  ackTimeoutMs?: number;
  /** Optional path to a host module handed to each worker (worker_threads). */
  hostModule?: string;
  /** Observability hook. */
  onEvent?: (event: ShardEvent) => void;
}

export type ShardEvent =
  | { type: 'worker_ready'; workerId: WorkerId }
  | { type: 'worker_unhealthy'; workerId: WorkerId }
  | { type: 'worker_exit'; workerId: WorkerId; code: number }
  | { type: 'stale_worker_message'; workerId: WorkerId; messageType: WorkerToManager['type'] }
  | { type: 'table_assigned'; workerId: WorkerId; tableId: TableId }
  | { type: 'table_reassigned'; tableId: TableId; from: WorkerId; to: WorkerId | null }
  | { type: 'drain_start'; workerId: WorkerId; tableCount: number }
  | { type: 'drain_complete'; workerId: WorkerId; timedOut: boolean }
  | { type: 'error'; workerId?: WorkerId; message: string; tableId?: TableId };

interface PendingAck<T = void> {
  workerId: WorkerId;
  workerGeneration: WorkerGeneration;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DrainProgress {
  closedTables: Map<TableId, OwnershipEpoch>;
}

export class InProcessShardManager implements ShardManager {
  private readonly router = new TableRouter();
  private readonly workers = new Map<WorkerId, WorkerRecord>();
  private readonly factory: WorkerFactory;
  private readonly heartbeatMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly hostModule?: string;
  private readonly onEvent: (event: ShardEvent) => void;

  // Correlation tables for request/response over the channel.
  private readonly readyAcks = new Map<string, PendingAck>();
  private readonly assignAcks = new Map<string, PendingAck>();
  private readonly unassignAcks = new Map<string, PendingAck>();
  private readonly drainAcks = new Map<
    string,
    PendingAck<Extract<WorkerToManager, { type: 'DRAINED' }>>
  >();
  private readonly pongAcks = new Map<string, PendingAck>();
  private readonly drainProgress = new Map<string, DrainProgress>();
  private readonly ownership = new Map<TableId, TableOwnership>();
  private readonly tableOperationTails = new Map<TableId, Promise<void>>();
  private nextOwnershipEpoch = 1;

  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(opts: InProcessShardManagerOptions) {
    this.factory = opts.factory;
    this.heartbeatMs = opts.heartbeatMs ?? 2000;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 6000;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 60_000;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 10_000;
    this.hostModule = opts.hostModule;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => this.sweepHealth(), this.heartbeatMs);
    (this.healthTimer as { unref?: () => void }).unref?.();
  }

  async spawnWorker(id?: WorkerId): Promise<WorkerId> {
    const workerId = id ?? `worker-${randomUUID().slice(0, 8)}`;
    if (this.workers.has(workerId)) throw new Error(`worker "${workerId}" already exists`);
    const generation = randomUUID();

    const channel = this.factory.create({
      workerId,
      workerGeneration: generation,
      heartbeatMs: this.heartbeatMs,
      hostModule: this.hostModule,
    });

    const record: WorkerRecord = {
      channel,
      generation,
      status: 'starting',
      tables: new Map(),
      inflightHands: 0,
      lastHeartbeatAt: Date.now(),
      pendingMutations: new Set(),
      fencePromise: null,
      drainInFlight: false,
    };
    this.workers.set(workerId, record);

    const readyKey = keyOf(workerId, generation, 'READY');
    const ready = this.awaitAck(
      this.readyAcks,
      readyKey,
      this.ackTimeoutMs,
      `worker "${workerId}" READY`,
      workerId,
      generation
    );
    channel.onMessage((msg) => this.onWorkerMessage(workerId, generation, msg));
    channel.onExit((code) => this.onWorkerExit(workerId, generation, code));

    try {
      await ready;
    } catch (err) {
      await this.fenceWorker(record, `worker did not become ready: ${errMsg(err)}`);
      throw err;
    }
    if (this.workers.get(workerId) !== record || record.status !== 'starting') {
      throw new Error(`worker "${workerId}" exited before READY completed`);
    }
    record.status = 'ready';
    record.lastHeartbeatAt = Date.now();
    this.router.addWorker(workerId);
    this.onEvent({ type: 'worker_ready', workerId });
    return workerId;
  }

  async assignTable(tableId: TableId): Promise<WorkerId> {
    return this.withTableOperation(tableId, async () => {
      let target = this.routeReady(tableId);
      if (!target) throw new Error(`no ready workers available to own table ${tableId}`);

      const current = this.ownership.get(tableId);
      if (current) {
        const currentRecord = this.workers.get(current.workerId);
        if (
          current.workerId === target &&
          currentRecord?.generation === current.workerGeneration &&
          currentRecord.status === 'ready' &&
          current.state === 'active'
        ) {
          return target;
        }
        if (!currentRecord || currentRecord.generation !== current.workerGeneration) {
          throw new Error(`table ${tableId} is fenced by a worker generation that has not exited`);
        }
        if (currentRecord.status !== 'ready') {
          throw new Error(
            `table ${tableId} remains fenced to ${current.workerId} (${currentRecord.status})`
          );
        }

        // Moving a live table is legal only after the old process confirms this
        // exact ownership epoch was closed. Failure is deliberately propagated.
        await this.unassignLease(current);
        target = this.routeReady(tableId);
        if (!target) throw new Error(`no ready workers available to own table ${tableId}`);
      }

      await this.sendAssign(target, tableId);
      return target;
    });
  }

  private async sendAssign(workerId: WorkerId, tableId: TableId): Promise<void> {
    const record = this.workers.get(workerId);
    if (!record) throw new Error(`unknown worker ${workerId}`);
    if (record.status !== 'ready') {
      throw new Error(`worker ${workerId} is ${record.status}, not ready`);
    }
    if (this.ownership.has(tableId)) {
      throw new Error(`table ${tableId} already has an ownership lease`);
    }

    const ownershipEpoch = this.allocateOwnershipEpoch();
    const lease: TableOwnership = {
      workerId,
      workerGeneration: record.generation,
      tableId,
      ownershipEpoch,
      state: 'assigning',
    };
    this.ownership.set(tableId, lease);
    record.tables.set(tableId, ownershipEpoch);

    const operation = (async () => {
      const ackKey = keyOf(workerId, record.generation, tableId, ownershipEpoch, 'ASSIGN');
      const ack = this.awaitAck(
        this.assignAcks,
        ackKey,
        this.ackTimeoutMs,
        `ASSIGN ${tableId} → ${workerId} at epoch ${ownershipEpoch}`,
        workerId,
        record.generation
      );
      try {
        record.channel.postMessage({
          type: 'ASSIGN',
          workerGeneration: record.generation,
          tableId,
          ownershipEpoch,
        });
        await ack;
      } catch (err) {
        // An ASSIGN failure is ambiguous: openTable may have produced a live
        // dealer before the acknowledgement was lost. Kill this incarnation
        // before its lease can be released or placed anywhere else.
        await this.fenceWorker(record, `ASSIGN ${tableId} failed: ${errMsg(err)}`);
        throw err;
      }

      const current = this.ownership.get(tableId);
      if (
        current !== lease ||
        this.workers.get(workerId) !== record ||
        (record.status !== 'ready' && record.status !== 'draining')
      ) {
        throw new Error(`ASSIGN ${tableId} acknowledgement arrived after its lease was fenced`);
      }
      lease.state = 'active';
      this.onEvent({ type: 'table_assigned', workerId, tableId });
    })();
    await this.trackWorkerMutation(record, operation);
  }

  async unassignTable(tableId: TableId): Promise<void> {
    await this.withTableOperation(tableId, async () => {
      const lease = this.ownership.get(tableId);
      if (!lease) return;
      await this.unassignLease(lease);
    });
  }

  private async unassignLease(lease: TableOwnership): Promise<void> {
    const record = this.workers.get(lease.workerId);
    if (!record || record.generation !== lease.workerGeneration) {
      throw new Error(
        `cannot unassign ${lease.tableId}: owner generation ${lease.workerGeneration} is unavailable`
      );
    }
    if (record.status !== 'ready') {
      throw new Error(
        `cannot unassign ${lease.tableId}: worker ${lease.workerId} is ${record.status}`
      );
    }

    const operation = (async () => {
      const ackKey = keyOf(
        lease.workerId,
        lease.workerGeneration,
        lease.tableId,
        lease.ownershipEpoch,
        'UNASSIGN'
      );
      const ack = this.awaitAck(
        this.unassignAcks,
        ackKey,
        this.ackTimeoutMs,
        `UNASSIGN ${lease.tableId} @ ${lease.workerId} epoch ${lease.ownershipEpoch}`,
        lease.workerId,
        lease.workerGeneration
      );
      try {
        record.channel.postMessage({
          type: 'UNASSIGN',
          workerGeneration: lease.workerGeneration,
          tableId: lease.tableId,
          ownershipEpoch: lease.ownershipEpoch,
        });
        await ack;
      } catch (err) {
        // A timed-out transport cannot prove whether closeTable ran. Fence the
        // process; an explicit worker ERROR retains the live lease for retry.
        if (err instanceof AckTimeoutError || err instanceof WorkerUnavailableError) {
          await this.fenceWorker(record, `UNASSIGN ${lease.tableId} was ambiguous: ${errMsg(err)}`);
        }
        throw err;
      }
      this.releaseOwnership(lease);
    })();
    await this.trackWorkerMutation(record, operation);
  }

  ownerOf(tableId: TableId): WorkerId | null {
    return this.ownership.get(tableId)?.workerId ?? null;
  }

  listWorkers(): WorkerHealth[] {
    return [...this.workers.entries()].map(([workerId, rec]) => ({
      workerId,
      workerGeneration: rec.generation,
      status: rec.status,
      tableCount: rec.tables.size,
      tables: [...rec.tables.keys()],
      inflightHands: rec.inflightHands,
      lastHeartbeatAt: rec.lastHeartbeatAt,
    }));
  }

  async healthCheck(): Promise<WorkerHealth[]> {
    const probes: Array<Promise<void>> = [];
    for (const [workerId, rec] of this.workers) {
      if (rec.status !== 'ready') continue;
      const nonce = Math.floor(Math.random() * 1e9);
      const ack = this.awaitAck(
        this.pongAcks,
        keyOf(workerId, rec.generation, nonce, 'PING'),
        this.ackTimeoutMs,
        `PING ${workerId}`,
        workerId,
        rec.generation
      );
      try {
        rec.channel.postMessage({
          type: 'PING',
          workerGeneration: rec.generation,
          nonce,
        });
      } catch (err) {
        this.rejectAck(
          this.pongAcks,
          keyOf(workerId, rec.generation, nonce, 'PING'),
          errMsg(err),
          WorkerUnavailableError
        );
      }
      probes.push(
        ack
          .then(() => {
            rec.lastHeartbeatAt = Date.now();
          })
          .catch(async (err) => {
            if (this.workers.get(workerId) === rec) await this.fenceWorker(rec, errMsg(err));
          })
      );
    }
    await Promise.all(probes);
    return this.listWorkers();
  }

  async drainWorker(workerId: WorkerId, opts: { timeoutMs?: number } = {}): Promise<DrainResult> {
    const record = this.workers.get(workerId);
    if (!record) throw new Error(`unknown worker ${workerId}`);
    if (record.status !== 'ready' && record.status !== 'draining') {
      throw new Error(`worker ${workerId} cannot drain while ${record.status}`);
    }
    if (record.drainInFlight) throw new Error(`worker ${workerId} already has a drain in flight`);
    record.drainInFlight = true;
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.drainTimeoutMs;

    // Take the worker out of routing before waiting for already-dispatched
    // mutations. Anything accepted while READY is included in the manifest.
    record.status = 'draining';
    this.router.removeWorker(workerId);
    await Promise.allSettled([...record.pendingMutations]);
    if (this.workers.get(workerId) !== record || record.status !== 'draining') {
      record.drainInFlight = false;
      throw new WorkerUnavailableError(`worker ${workerId} exited while its drain was starting`);
    }

    const owned = [...this.ownership.values()]
      .filter(
        (lease) =>
          lease.workerId === workerId &&
          lease.workerGeneration === record.generation &&
          lease.state === 'active'
      )
      .map(({ tableId, ownershipEpoch }) => ({ tableId, ownershipEpoch }));
    this.onEvent({ type: 'drain_start', workerId, tableCount: owned.length });

    const drainId = randomUUID();
    const drainKey = keyOf(workerId, record.generation, drainId, 'DRAIN');
    const progress: DrainProgress = { closedTables: new Map() };
    this.drainProgress.set(drainKey, progress);
    const ack = this.awaitAck(
      this.drainAcks,
      drainKey,
      timeoutMs,
      `DRAIN ${workerId} generation ${record.generation}`,
      workerId,
      record.generation
    );
    let timedOut = false;
    let report: Extract<WorkerToManager, { type: 'DRAINED' }> | null = null;
    try {
      record.channel.postMessage({
        type: 'DRAIN',
        workerGeneration: record.generation,
        drainId,
        tables: owned,
      });
      report = await ack;
    } catch (err) {
      timedOut = err instanceof AckTimeoutError;
      this.onEvent({ type: 'error', workerId, message: errMsg(err) });
    }

    const { closed, failures } = this.validateDrainReport(owned, progress, report, timedOut);
    this.drainProgress.delete(drainKey);
    for (const lease of closed) {
      const current = this.ownership.get(lease.tableId);
      if (
        current?.workerId === workerId &&
        current.workerGeneration === record.generation &&
        current.ownershipEpoch === lease.ownershipEpoch
      ) {
        this.releaseOwnership(current);
      }
    }
    for (const failure of failures) this.retainFailureOwnership(record, failure);

    // Only exact TABLE_CLOSED + DRAINED matches (or exact TABLE_CLOSED before a
    // timeout) are eligible for handoff. Failed/unverified leases stay fenced.
    const reassigned: Reassignment[] = [];
    for (const lease of closed) {
      const to = this.routeReady(lease.tableId);
      if (to) {
        try {
          await this.sendAssign(to, lease.tableId);
          reassigned.push({ tableId: lease.tableId, from: workerId, to });
          this.onEvent({ type: 'table_reassigned', tableId: lease.tableId, from: workerId, to });
        } catch (err) {
          reassigned.push({ tableId: lease.tableId, from: workerId, to: null });
          this.onEvent({
            type: 'error',
            workerId: to,
            tableId: lease.tableId,
            message: errMsg(err),
          });
        }
      } else {
        reassigned.push({ tableId: lease.tableId, from: workerId, to: null });
        this.onEvent({
          type: 'table_reassigned',
          tableId: lease.tableId,
          from: workerId,
          to: null,
        });
      }
    }

    const result: DrainResult = {
      workerId,
      completed: !timedOut && failures.length === 0,
      reassigned,
      closedTables: closed.map((lease) => lease.tableId),
      failedTables: failures,
      durationMs: Date.now() - started,
      timedOut,
    };

    if (!result.completed) {
      record.drainInFlight = false;
      throw new DrainFailedError(result);
    }

    try {
      record.channel.postMessage({ type: 'SHUTDOWN', workerGeneration: record.generation });
      await record.channel.terminate();
    } catch (err) {
      record.status = 'unhealthy';
      record.drainInFlight = false;
      this.onEvent({ type: 'error', workerId, message: `terminate failed: ${errMsg(err)}` });
      throw err;
    }
    this.finalizeWorkerStop(record);
    record.drainInFlight = false;
    this.onEvent({ type: 'drain_complete', workerId, timedOut: false });
    return result;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    const records = [...this.workers.values()];
    const terminationResults = await Promise.allSettled(
      records.map(async (rec) => {
        rec.channel.postMessage({ type: 'SHUTDOWN', workerGeneration: rec.generation });
        await rec.channel.terminate();
        this.finalizeWorkerStop(rec, 'shard manager shutting down');
      })
    );
    this.router.setWorkers([]);
    // Reject any dangling acks.
    for (const map of [
      this.readyAcks,
      this.assignAcks,
      this.unassignAcks,
      this.drainAcks,
      this.pongAcks,
    ]) {
      for (const [, pending] of map) {
        clearTimeout(pending.timer);
        pending.reject(new Error('shard manager shutting down'));
      }
      map.clear();
    }
    this.drainProgress.clear();
    const failures = terminationResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    for (const [index, result] of terminationResults.entries()) {
      if (
        result.status === 'rejected' &&
        this.workers.get(records[index].channel.id) === records[index]
      ) {
        records[index].status = 'unhealthy';
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'one or more shard workers failed to stop');
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private onWorkerMessage(
    workerId: WorkerId,
    generation: WorkerGeneration,
    msg: WorkerToManager
  ): void {
    const record = this.workers.get(workerId);
    if (
      !record ||
      record.generation !== generation ||
      msg.workerId !== workerId ||
      msg.workerGeneration !== generation ||
      record.status === 'stopped' ||
      record.status === 'unhealthy'
    ) {
      this.onEvent({ type: 'stale_worker_message', workerId, messageType: msg.type });
      return;
    }
    switch (msg.type) {
      case 'READY':
        if (record.status === 'starting') {
          this.resolveAck(this.readyAcks, keyOf(workerId, generation, 'READY'), undefined);
        }
        break;
      case 'HEARTBEAT':
        record.lastHeartbeatAt = Date.now();
        record.inflightHands = msg.inflightHands;
        break;
      case 'ASSIGNED':
        this.resolveAck(
          this.assignAcks,
          keyOf(workerId, generation, msg.tableId, msg.ownershipEpoch, 'ASSIGN'),
          undefined
        );
        break;
      case 'UNASSIGNED':
        this.resolveAck(
          this.unassignAcks,
          keyOf(workerId, generation, msg.tableId, msg.ownershipEpoch, 'UNASSIGN'),
          undefined
        );
        break;
      case 'TABLE_CLOSED': {
        const progress = this.drainProgress.get(keyOf(workerId, generation, msg.drainId, 'DRAIN'));
        progress?.closedTables.set(msg.tableId, msg.ownershipEpoch);
        break;
      }
      case 'DRAINED':
        this.resolveAck(this.drainAcks, keyOf(workerId, generation, msg.drainId, 'DRAIN'), msg);
        break;
      case 'PONG':
        this.resolveAck(this.pongAcks, keyOf(workerId, generation, msg.nonce, 'PING'), undefined);
        break;
      case 'ERROR':
        this.onEvent({ type: 'error', workerId, tableId: msg.tableId, message: msg.message });
        if (msg.tableId !== undefined && msg.ownershipEpoch !== undefined) {
          if (msg.operation === 'ASSIGN') {
            this.rejectAck(
              this.assignAcks,
              keyOf(workerId, generation, msg.tableId, msg.ownershipEpoch, 'ASSIGN'),
              msg.message,
              WorkerOperationError
            );
          } else if (msg.operation === 'UNASSIGN') {
            this.rejectAck(
              this.unassignAcks,
              keyOf(workerId, generation, msg.tableId, msg.ownershipEpoch, 'UNASSIGN'),
              msg.message,
              WorkerOperationError
            );
          }
        } else if (record.status === 'starting') {
          this.rejectAck(
            this.readyAcks,
            keyOf(workerId, generation, 'READY'),
            msg.message,
            WorkerOperationError
          );
        }
        break;
    }
  }

  private onWorkerExit(workerId: WorkerId, generation: WorkerGeneration, code: number): void {
    const record = this.workers.get(workerId);
    if (!record || record.generation !== generation || record.status === 'stopped') return;
    this.finalizeWorkerStop(record, `worker exited with code ${code}`);
    this.onEvent({ type: 'worker_exit', workerId, code });
  }

  private sweepHealth(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const [workerId, rec] of this.workers) {
      if (rec.status === 'draining' || rec.status === 'stopped') continue;
      if (now - rec.lastHeartbeatAt > this.heartbeatTimeoutMs && rec.status !== 'unhealthy') {
        void this.fenceWorker(rec, 'heartbeat timeout');
      }
    }
  }

  private awaitAck<T>(
    map: Map<string, PendingAck<T>>,
    key: string,
    timeoutMs: number,
    label: string,
    workerId: WorkerId,
    workerGeneration: WorkerGeneration
  ): Promise<T> {
    if (map.has(key))
      return Promise.reject(new Error(`duplicate pending acknowledgement: ${label}`));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        map.delete(key);
        reject(new AckTimeoutError(`timeout waiting for ${label}`));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      map.set(key, { workerId, workerGeneration, resolve, reject, timer });
    });
  }

  private resolveAck<T>(map: Map<string, PendingAck<T>>, key: string, value: T): void {
    const pending = map.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    map.delete(key);
    pending.resolve(value);
  }

  private rejectAck<T, E extends Error>(
    map: Map<string, PendingAck<T>>,
    key: string,
    message: string,
    ErrorType: new (message: string) => E
  ): void {
    const pending = map.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    map.delete(key);
    pending.reject(new ErrorType(message));
  }

  private routeReady(tableId: TableId): WorkerId | null {
    while (true) {
      const workerId = this.router.route(tableId);
      if (!workerId) return null;
      const record = this.workers.get(workerId);
      if (record?.status === 'ready') return workerId;
      this.router.removeWorker(workerId);
    }
  }

  private allocateOwnershipEpoch(): OwnershipEpoch {
    if (!Number.isSafeInteger(this.nextOwnershipEpoch)) {
      throw new Error('ownership epoch exhausted');
    }
    return this.nextOwnershipEpoch++;
  }

  private async withTableOperation<T>(tableId: TableId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tableOperationTails.get(tableId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined
    );
    this.tableOperationTails.set(tableId, settled);
    try {
      return await current;
    } finally {
      if (this.tableOperationTails.get(tableId) === settled)
        this.tableOperationTails.delete(tableId);
    }
  }

  private async trackWorkerMutation(record: WorkerRecord, operation: Promise<void>): Promise<void> {
    const settled = operation.then(
      () => undefined,
      () => undefined
    );
    record.pendingMutations.add(settled);
    try {
      await operation;
    } finally {
      record.pendingMutations.delete(settled);
    }
  }

  private releaseOwnership(lease: TableOwnership): void {
    if (this.ownership.get(lease.tableId) !== lease) return;
    this.ownership.delete(lease.tableId);
    const record = this.workers.get(lease.workerId);
    if (record?.generation === lease.workerGeneration) record.tables.delete(lease.tableId);
  }

  private validateDrainReport(
    expectedLeases: TableLease[],
    progress: DrainProgress,
    report: Extract<WorkerToManager, { type: 'DRAINED' }> | null,
    timedOut: boolean
  ): { closed: TableLease[]; failures: TableCloseFailure[] } {
    const reportClosed = new Map(report?.closedTables.map((lease) => [lease.tableId, lease]) ?? []);
    const reportFailed = new Map(
      report?.failedTables.map((failure) => [failure.tableId, failure]) ?? []
    );
    const expected = new Map(expectedLeases.map((lease) => [lease.tableId, lease]));
    const closed: TableLease[] = [];
    const failures: TableCloseFailure[] = [];

    for (const lease of expectedLeases) {
      const eventEpoch = progress.closedTables.get(lease.tableId);
      const reportedClose = reportClosed.get(lease.tableId);
      const reportedFailure = reportFailed.get(lease.tableId);
      const exactClose =
        eventEpoch === lease.ownershipEpoch &&
        (timedOut || reportedClose?.ownershipEpoch === lease.ownershipEpoch);
      const exactFailure = reportedFailure?.ownershipEpoch === lease.ownershipEpoch;
      if (exactClose && exactFailure) {
        failures.push({
          ...lease,
          message: 'worker reported the same ownership lease as both closed and failed',
        });
      } else if (exactClose) {
        closed.push(lease);
      } else if (exactFailure) {
        failures.push(reportedFailure);
      } else {
        failures.push({
          ...lease,
          message: timedOut
            ? 'drain timed out before an exact per-table close was verified'
            : 'DRAINED omitted a matching TABLE_CLOSED acknowledgement',
        });
      }
    }

    for (const failure of report?.failedTables ?? []) {
      const lease = expected.get(failure.tableId);
      if (lease?.ownershipEpoch === failure.ownershipEpoch) continue;
      failures.push({ ...failure, message: `unexpected worker-side lease: ${failure.message}` });
    }
    for (const lease of report?.closedTables ?? []) {
      const expectedLease = expected.get(lease.tableId);
      if (expectedLease?.ownershipEpoch === lease.ownershipEpoch) continue;
      failures.push({ ...lease, message: 'worker closed an unexpected ownership lease' });
    }

    return { closed, failures };
  }

  private retainFailureOwnership(record: WorkerRecord, failure: TableCloseFailure): void {
    if (this.workers.get(record.channel.id) !== record || record.status === 'stopped') return;
    if (this.ownership.has(failure.tableId)) return;
    const lease: TableOwnership = {
      workerId: record.channel.id,
      workerGeneration: record.generation,
      tableId: failure.tableId,
      ownershipEpoch: failure.ownershipEpoch,
      state: 'active',
    };
    this.ownership.set(failure.tableId, lease);
    record.tables.set(failure.tableId, failure.ownershipEpoch);
    this.nextOwnershipEpoch = Math.max(this.nextOwnershipEpoch, failure.ownershipEpoch + 1);
  }

  private async fenceWorker(record: WorkerRecord, reason: string): Promise<boolean> {
    if (record.status === 'stopped') return true;
    if (record.fencePromise) return record.fencePromise;
    record.status = 'unhealthy';
    this.router.removeWorker(record.channel.id);
    this.onEvent({ type: 'worker_unhealthy', workerId: record.channel.id });
    this.rejectWorkerAcks(record, reason);

    record.fencePromise = (async () => {
      try {
        await record.channel.terminate();
      } catch (err) {
        this.onEvent({
          type: 'error',
          workerId: record.channel.id,
          message: `failed to fence unhealthy worker: ${errMsg(err)}`,
        });
        return false;
      }
      this.finalizeWorkerStop(record, reason);
      return true;
    })();
    return record.fencePromise;
  }

  private finalizeWorkerStop(record: WorkerRecord, reason = 'worker stopped'): void {
    const workerId = record.channel.id;
    if (this.workers.get(workerId) !== record) return;
    record.status = 'stopped';
    this.router.removeWorker(workerId);
    this.rejectWorkerAcks(record, reason);
    for (const lease of [...this.ownership.values()]) {
      if (lease.workerId === workerId && lease.workerGeneration === record.generation) {
        this.releaseOwnership(lease);
      }
    }
    record.tables.clear();
    this.workers.delete(workerId);
  }

  private rejectWorkerAcks(record: WorkerRecord, reason: string): void {
    for (const map of [
      this.readyAcks,
      this.assignAcks,
      this.unassignAcks,
      this.drainAcks,
      this.pongAcks,
    ]) {
      for (const [key, pending] of map) {
        if (
          pending.workerId !== record.channel.id ||
          pending.workerGeneration !== record.generation
        ) {
          continue;
        }
        clearTimeout(pending.timer);
        map.delete(key);
        pending.reject(new WorkerUnavailableError(reason));
      }
    }
  }
}

// ─── InlineWorkerFactory: in-process workers (tests + zero-thread fallback) ───

/**
 * Runs the worker runtime IN THE SAME PROCESS. Used by unit tests (deterministic,
 * no thread flakiness) and as a legitimate single-threaded fallback. Delivery is
 * marshalled through microtasks so it mimics async message passing.
 */
export class InlineWorkerFactory implements WorkerFactory {
  constructor(
    private readonly hostFor: (workerId: WorkerId) => TableHost = () => new NoopTableHost()
  ) {}

  create(data: ShardWorkerData): WorkerChannel {
    const listeners: Array<(msg: WorkerToManager) => void> = [];
    const runtime = new ShardWorkerRuntime({
      workerId: data.workerId,
      workerGeneration: data.workerGeneration,
      host: this.hostFor(data.workerId),
      heartbeatMs: data.heartbeatMs,
      send: (msg) => queueMicrotask(() => listeners.forEach((l) => l(msg))),
    });
    // Announce readiness on the next microtask so onMessage is wired first.
    queueMicrotask(() => runtime.begin());

    return {
      id: data.workerId,
      postMessage: (msg) => {
        void runtime.handle(msg);
      },
      onMessage: (cb) => {
        listeners.push(cb);
      },
      onExit: () => {},
      terminate: async () => {
        await runtime.terminate();
      },
    };
  }
}

// ─── NodeWorkerFactory: real worker_threads (production single-node) ──────────

/**
 * Spawns each engine worker as a real `worker_threads.Worker` running
 * `scaleWorkerHarness`. Pass the resolved harness script URL (built .js in prod,
 * or the .ts via a tsx loader in dev). The harness loads `data.hostModule` to
 * obtain a TableHost that wraps ServerTableEngine.
 *
 * Kept as a thin wrapper so the control plane never imports worker_threads
 * directly and stays trivially testable with InlineWorkerFactory.
 */
export class NodeWorkerFactory implements WorkerFactory {
  constructor(private readonly workerScriptUrl: string | URL) {}

  create(data: ShardWorkerData): WorkerChannel {
    const worker = new Worker(this.workerScriptUrl, { workerData: data });
    return {
      id: data.workerId,
      postMessage: (msg) => worker.postMessage(msg),
      onMessage: (cb) => worker.on('message', cb as (msg: unknown) => void),
      onExit: (cb) => worker.on('exit', cb),
      terminate: async () => {
        await worker.terminate();
      },
    };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class AckTimeoutError extends Error {
  override name = 'AckTimeoutError';
}

class WorkerOperationError extends Error {
  override name = 'WorkerOperationError';
}

class WorkerUnavailableError extends Error {
  override name = 'WorkerUnavailableError';
}

function keyOf(...parts: Array<string | number>): string {
  return JSON.stringify(parts);
}

/*
 * ─── Multi-node seam (future — needs infra provisioning) ─────────────────────
 *
 * A `MultiNodeShardManager implements ShardManager` would:
 *   - Keep the SAME TableRouter, but its worker set is the union of workers
 *     across ALL nodes (each node registers its workers in a shared store —
 *     Redis hash / NATS KV — keyed by workerId → nodeAddress).
 *   - Route ASSIGN/DRAIN/PING to remote workers by publishing the exact same
 *     protocol messages over a CrossNodeBus request-reply subject instead of a
 *     worker_threads port. WorkerChannel gets a `RemoteWorkerChannel` impl.
 *   - Use the shared store as the ownership source of truth so a WS gateway on
 *     any node can look up "which node/worker owns table X" and proxy the socket
 *     (or 307-redirect) there.
 *   - On node failure, another node's manager detects the missing heartbeat and
 *     re-routes that node's tables (they resume from the event log — stateless
 *     workers), which is the same code path as drainWorker's step 4.
 * Nothing in the interface changes; only WorkerChannel + the ownership store are
 * new. See README "Path to multi-node".
 */
