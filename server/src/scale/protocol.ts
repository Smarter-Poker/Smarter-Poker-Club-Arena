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

// ─── Manager → Worker ─────────────────────────────────────────────────────────

export type ManagerToWorker =
  /** Take ownership of a table (open a fresh engine, or resume from event log). */
  | { type: 'ASSIGN'; tableId: TableId }
  /** Release a table WITHOUT draining (hard move; rarely used). */
  | { type: 'UNASSIGN'; tableId: TableId }
  /** Begin graceful drain: finish in-flight hands on every owned table, then close them. */
  | { type: 'DRAIN' }
  /** Liveness probe. Worker must reply PONG. */
  | { type: 'PING'; nonce: number }
  /** Terminate: dispose everything and exit. */
  | { type: 'SHUTDOWN' };

// ─── Worker → Manager ─────────────────────────────────────────────────────────

export type WorkerToManager =
  /** Sent once the worker has booted and is ready to receive ASSIGNs. */
  | { type: 'READY'; workerId: WorkerId }
  /** Periodic liveness + load report. */
  | {
      type: 'HEARTBEAT';
      workerId: WorkerId;
      tableCount: number;
      /** Number of hands currently mid-flight across all owned tables. */
      inflightHands: number;
    }
  | { type: 'ASSIGNED'; workerId: WorkerId; tableId: TableId }
  | { type: 'UNASSIGNED'; workerId: WorkerId; tableId: TableId }
  /** A table finished its in-flight hand and closed (during drain or naturally). */
  | { type: 'TABLE_CLOSED'; workerId: WorkerId; tableId: TableId }
  /** All owned tables have closed; safe to terminate this worker. */
  | { type: 'DRAINED'; workerId: WorkerId }
  | { type: 'PONG'; workerId: WorkerId; nonce: number }
  | { type: 'ERROR'; workerId: WorkerId; message: string; tableId?: TableId };

/**
 * Data passed to a worker thread at construction (worker_threads `workerData`).
 * `hostModule` is the path to a module exporting `createTableHost()` — this is
 * the seam the engine-owning code plugs ServerTableEngine into (see README).
 */
export interface ShardWorkerData {
  workerId: WorkerId;
  heartbeatMs: number;
  /** Optional path to a module exporting a TableHost factory. */
  hostModule?: string;
}
