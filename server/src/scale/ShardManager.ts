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
  TableId,
  ShardWorkerData,
} from './protocol.js';
import { ShardWorkerRuntime, NoopTableHost, type TableHost } from './ShardWorkerRuntime.js';

export type { TableHost } from './ShardWorkerRuntime.js';

export type WorkerStatus = 'starting' | 'ready' | 'draining' | 'unhealthy' | 'stopped';

export interface WorkerHealth {
  workerId: WorkerId;
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
  reassigned: Reassignment[];
  closedTables: TableId[];
  durationMs: number;
  timedOut: boolean;
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
  status: WorkerStatus;
  tables: Set<TableId>;
  inflightHands: number;
  lastHeartbeatAt: number;
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
  | { type: 'table_assigned'; workerId: WorkerId; tableId: TableId }
  | { type: 'table_reassigned'; tableId: TableId; from: WorkerId; to: WorkerId | null }
  | { type: 'drain_start'; workerId: WorkerId; tableCount: number }
  | { type: 'drain_complete'; workerId: WorkerId; timedOut: boolean }
  | { type: 'error'; workerId?: WorkerId; message: string; tableId?: TableId };

interface PendingAck {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
  private readonly readyAcks = new Map<WorkerId, PendingAck>();
  private readonly assignAcks = new Map<string, PendingAck>(); // key: `${workerId}::${tableId}`
  private readonly unassignAcks = new Map<string, PendingAck>();
  private readonly drainAcks = new Map<WorkerId, PendingAck>();
  private readonly pongAcks = new Map<string, PendingAck>(); // key: `${workerId}::${nonce}`

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

    const channel = this.factory.create({
      workerId,
      heartbeatMs: this.heartbeatMs,
      hostModule: this.hostModule,
    });

    const record: WorkerRecord = {
      channel,
      status: 'starting',
      tables: new Set(),
      inflightHands: 0,
      lastHeartbeatAt: Date.now(),
    };
    this.workers.set(workerId, record);

    channel.onMessage((msg) => this.onWorkerMessage(workerId, msg));
    channel.onExit((code) => this.onWorkerExit(workerId, code));

    // Wait for READY.
    await this.awaitAck(this.readyAcks, workerId, this.ackTimeoutMs, `worker "${workerId}" READY`);
    record.status = 'ready';
    record.lastHeartbeatAt = Date.now();
    this.router.addWorker(workerId);
    this.onEvent({ type: 'worker_ready', workerId });
    return workerId;
  }

  async assignTable(tableId: TableId): Promise<WorkerId> {
    const target = this.router.route(tableId);
    if (!target) throw new Error(`no workers available to own table ${tableId}`);

    // Already owned by the routed worker? no-op.
    const current = this.ownerOf(tableId);
    if (current === target) return target;

    // Owned elsewhere (shouldn't normally happen without a topology change) — release first.
    if (current && current !== target) {
      await this.unassignTable(tableId).catch(() => {});
    }

    await this.sendAssign(target, tableId);
    return target;
  }

  private async sendAssign(workerId: WorkerId, tableId: TableId): Promise<void> {
    const record = this.workers.get(workerId);
    if (!record) throw new Error(`unknown worker ${workerId}`);
    record.channel.postMessage({ type: 'ASSIGN', tableId });
    await this.awaitAck(
      this.assignAcks,
      `${workerId}::${tableId}`,
      this.ackTimeoutMs,
      `ASSIGN ${tableId} → ${workerId}`
    );
    record.tables.add(tableId);
    this.onEvent({ type: 'table_assigned', workerId, tableId });
  }

  async unassignTable(tableId: TableId): Promise<void> {
    const owner = this.ownerOf(tableId);
    if (!owner) return;
    const record = this.workers.get(owner);
    if (!record) return;
    record.channel.postMessage({ type: 'UNASSIGN', tableId });
    await this.awaitAck(
      this.unassignAcks,
      `${owner}::${tableId}`,
      this.ackTimeoutMs,
      `UNASSIGN ${tableId} @ ${owner}`
    );
    record.tables.delete(tableId);
  }

  ownerOf(tableId: TableId): WorkerId | null {
    for (const [id, rec] of this.workers) {
      if (rec.tables.has(tableId)) return id;
    }
    return null;
  }

  listWorkers(): WorkerHealth[] {
    return [...this.workers.entries()].map(([workerId, rec]) => ({
      workerId,
      status: rec.status,
      tableCount: rec.tables.size,
      tables: [...rec.tables],
      inflightHands: rec.inflightHands,
      lastHeartbeatAt: rec.lastHeartbeatAt,
    }));
  }

  async healthCheck(): Promise<WorkerHealth[]> {
    const probes: Array<Promise<void>> = [];
    for (const [workerId, rec] of this.workers) {
      if (rec.status === 'stopped') continue;
      const nonce = Math.floor(Math.random() * 1e9);
      rec.channel.postMessage({ type: 'PING', nonce });
      probes.push(
        this.awaitAck(this.pongAcks, `${workerId}::${nonce}`, this.ackTimeoutMs, `PING ${workerId}`)
          .then(() => {
            rec.lastHeartbeatAt = Date.now();
            if (rec.status === 'unhealthy') rec.status = 'ready';
          })
          .catch(() => {
            rec.status = 'unhealthy';
            this.onEvent({ type: 'worker_unhealthy', workerId });
          })
      );
    }
    await Promise.all(probes);
    return this.listWorkers();
  }

  async drainWorker(workerId: WorkerId, opts: { timeoutMs?: number } = {}): Promise<DrainResult> {
    const record = this.workers.get(workerId);
    if (!record) throw new Error(`unknown worker ${workerId}`);
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.drainTimeoutMs;

    // 1. Take the worker out of routing so no new tables land on it.
    record.status = 'draining';
    this.router.removeWorker(workerId);

    // 2. Snapshot the tables it currently owns (for handoff after close).
    const owned = [...record.tables];
    this.onEvent({ type: 'drain_start', workerId, tableCount: owned.length });

    // 3. Tell the worker to finish in-flight hands and close every table.
    record.channel.postMessage({ type: 'DRAIN' });
    let timedOut = false;
    try {
      await this.awaitAck(this.drainAcks, workerId, timeoutMs, `DRAIN ${workerId}`);
    } catch {
      timedOut = true;
      this.onEvent({ type: 'error', workerId, message: 'drain timed out' });
    }

    // 4. Hand each table to a surviving worker (event-log-backed resume).
    const reassigned: Reassignment[] = [];
    for (const tableId of owned) {
      const to = this.router.route(tableId);
      if (to && this.workers.has(to)) {
        try {
          await this.sendAssign(to, tableId);
          reassigned.push({ tableId, from: workerId, to });
          this.onEvent({ type: 'table_reassigned', tableId, from: workerId, to });
        } catch (err) {
          reassigned.push({ tableId, from: workerId, to: null });
          this.onEvent({ type: 'error', workerId: to, tableId, message: errMsg(err) });
        }
      } else {
        // Nowhere to place it — surfaced so the caller can spawn capacity.
        reassigned.push({ tableId, from: workerId, to: null });
        this.onEvent({ type: 'table_reassigned', tableId, from: workerId, to: null });
      }
    }

    // 5. Terminate the drained worker.
    record.channel.postMessage({ type: 'SHUTDOWN' });
    await record.channel.terminate().catch(() => {});
    record.status = 'stopped';
    this.workers.delete(workerId);
    this.onEvent({ type: 'drain_complete', workerId, timedOut });

    return {
      workerId,
      reassigned,
      closedTables: owned,
      durationMs: Date.now() - started,
      timedOut,
    };
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    const terminations: Array<Promise<void>> = [];
    for (const [, rec] of this.workers) {
      rec.channel.postMessage({ type: 'SHUTDOWN' });
      terminations.push(rec.channel.terminate().catch(() => {}));
    }
    await Promise.all(terminations);
    this.workers.clear();
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
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private onWorkerMessage(workerId: WorkerId, msg: WorkerToManager): void {
    const record = this.workers.get(workerId);
    switch (msg.type) {
      case 'READY':
        this.resolveAck(this.readyAcks, workerId);
        break;
      case 'HEARTBEAT':
        if (record) {
          record.lastHeartbeatAt = Date.now();
          record.inflightHands = msg.inflightHands;
          if (record.status === 'unhealthy') record.status = 'ready';
        }
        break;
      case 'ASSIGNED':
        this.resolveAck(this.assignAcks, `${workerId}::${msg.tableId}`);
        break;
      case 'UNASSIGNED':
        this.resolveAck(this.unassignAcks, `${workerId}::${msg.tableId}`);
        break;
      case 'TABLE_CLOSED':
        record?.tables.delete(msg.tableId);
        break;
      case 'DRAINED':
        this.resolveAck(this.drainAcks, workerId);
        break;
      case 'PONG':
        this.resolveAck(this.pongAcks, `${workerId}::${msg.nonce}`);
        break;
      case 'ERROR':
        this.onEvent({ type: 'error', workerId, tableId: msg.tableId, message: msg.message });
        // Fail a pending assign for this table so callers don't hang.
        if (msg.tableId)
          this.rejectAck(this.assignAcks, `${workerId}::${msg.tableId}`, msg.message);
        break;
    }
  }

  private onWorkerExit(workerId: WorkerId, code: number): void {
    const record = this.workers.get(workerId);
    if (!record || record.status === 'stopped') return;
    record.status = 'stopped';
    this.router.removeWorker(workerId);
    this.onEvent({ type: 'worker_exit', workerId, code });
  }

  private sweepHealth(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const [workerId, rec] of this.workers) {
      if (rec.status === 'draining' || rec.status === 'stopped') continue;
      if (now - rec.lastHeartbeatAt > this.heartbeatTimeoutMs && rec.status !== 'unhealthy') {
        rec.status = 'unhealthy';
        this.onEvent({ type: 'worker_unhealthy', workerId });
      }
    }
  }

  private awaitAck(
    map: Map<string, PendingAck>,
    key: string,
    timeoutMs: number,
    label: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        map.delete(key);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      map.set(key, { resolve, reject, timer });
    });
  }

  private resolveAck(map: Map<string, PendingAck>, key: string): void {
    const pending = map.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    map.delete(key);
    pending.resolve();
  }

  private rejectAck(map: Map<string, PendingAck>, key: string, message: string): void {
    const pending = map.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    map.delete(key);
    pending.reject(new Error(message));
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
        runtime.stop();
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
