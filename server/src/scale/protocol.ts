/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shard control-plane protocol
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The message contract between the ShardManager (control plane, runs on the main
 * thread / orchestrator node) and each engine worker (data plane, runs the
 * ServerTableEngine instances). It is deliberately transport-neutral: the same
 * messages travel over `worker_threads` MessagePort today and could travel over
 * a Redis stream / NATS request-reply between nodes tomorrow.
 *
 * Standalone: imports nothing from the engine/server.
 */

export type WorkerId = string;
export type TableId = string;
/** Unique token for one concrete worker process/thread incarnation. */
export type WorkerGeneration = string;
/** Monotonic control-plane lease version for a table. */
export type OwnershipEpoch = number;

export interface TableLease {
  tableId: TableId;
  ownershipEpoch: OwnershipEpoch;
}

export interface TableCloseFailure extends TableLease {
  message: string;
}

// ─── Manager → Worker ─────────────────────────────────────────────────────────

export type ManagerToWorker =
  /** Take ownership of a table (open a fresh engine, or resume from event log). */
  | ({ type: 'ASSIGN'; workerGeneration: WorkerGeneration } & TableLease)
  /** Release a table WITHOUT draining (hard move; rarely used). */
  | ({ type: 'UNASSIGN'; workerGeneration: WorkerGeneration } & TableLease)
  /** Begin graceful drain: finish in-flight hands on every owned table, then close them. */
  | {
      type: 'DRAIN';
      workerGeneration: WorkerGeneration;
      drainId: string;
      tables: TableLease[];
    }
  /** Liveness probe. Worker must reply PONG. */
  | { type: 'PING'; workerGeneration: WorkerGeneration; nonce: number }
  /** Terminate: dispose everything and exit. */
  | { type: 'SHUTDOWN'; workerGeneration: WorkerGeneration };

// ─── Worker → Manager ─────────────────────────────────────────────────────────

export type WorkerToManager =
  /** Sent once the worker has booted and is ready to receive ASSIGNs. */
  | { type: 'READY'; workerId: WorkerId; workerGeneration: WorkerGeneration }
  /** Periodic liveness + load report. */
  | {
      type: 'HEARTBEAT';
      workerId: WorkerId;
      workerGeneration: WorkerGeneration;
      tableCount: number;
      /** Number of hands currently mid-flight across all owned tables. */
      inflightHands: number;
    }
  | ({ type: 'ASSIGNED'; workerId: WorkerId; workerGeneration: WorkerGeneration } & TableLease)
  | ({ type: 'UNASSIGNED'; workerId: WorkerId; workerGeneration: WorkerGeneration } & TableLease)
  /** A table finished its in-flight hand and closed (during drain or naturally). */
  | ({
      type: 'TABLE_CLOSED';
      workerId: WorkerId;
      workerGeneration: WorkerGeneration;
      drainId: string;
    } & TableLease)
  /** All owned tables have closed; safe to terminate this worker. */
  | {
      type: 'DRAINED';
      workerId: WorkerId;
      workerGeneration: WorkerGeneration;
      drainId: string;
      closedTables: TableLease[];
      failedTables: TableCloseFailure[];
    }
  | {
      type: 'PONG';
      workerId: WorkerId;
      workerGeneration: WorkerGeneration;
      nonce: number;
    }
  | {
      type: 'ERROR';
      workerId: WorkerId;
      workerGeneration: WorkerGeneration;
      message: string;
      operation?: 'ASSIGN' | 'UNASSIGN' | 'DRAIN';
      tableId?: TableId;
      ownershipEpoch?: OwnershipEpoch;
      drainId?: string;
    };

/**
 * Data passed to a worker thread at construction (worker_threads `workerData`).
 * `hostModule` is the path to a module exporting `createTableHost()` — this is
 * the seam the engine-owning code plugs ServerTableEngine into (see README).
 */
export interface ShardWorkerData {
  workerId: WorkerId;
  workerGeneration: WorkerGeneration;
  heartbeatMs: number;
  /** Optional path to a module exporting a TableHost factory. */
  hostModule?: string;
}
