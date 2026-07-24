/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ShardWorkerRuntime — the worker-side "brain" of a shard
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Reusable, transport-neutral logic that lives INSIDE an engine worker. It
 * translates control-plane messages (ManagerToWorker) into calls on a
 * `TableHost`, and emits status back (WorkerToManager) via an injected `send`.
 *
 * Because it is transport-neutral, the exact same runtime is used by:
 *   - `scaleWorkerHarness.ts` — real `worker_threads` entry (production).
 *   - `InlineWorkerFactory` (in ShardManager.ts) — an in-process worker used by
 *     unit tests and as a zero-thread fallback.
 *
 * The `TableHost` is the single seam the engine-owning code implements to wire
 * `ServerTableEngine` into the shard model — see README "Integration".
 */

import type { ManagerToWorker, WorkerToManager, WorkerId, TableId } from './protocol.js';

/**
 * What a worker must be able to do to a table. The production implementation
 * (owned by the engine agent) maps these onto ServerTableEngine:
 *
 *   openTable   → new ServerTableEngine(id); engine.setHub(hub); engine.start()
 *                 (or resume from the event log for a stateless handoff)
 *   drainTable  → engine.pauseAfterHand(); await hand boundary; engine.stop()
 *   closeTable  → engine.stop() immediately
 *   inflightHands → sum of engines currently mid-hand
 *   tableIds    → ids of engines this worker owns
 */
export interface TableHost {
  openTable(tableId: TableId): Promise<void> | void;
  /** Finish the in-flight hand for this table (hand-boundary-safe) then close it. */
  drainTable(tableId: TableId): Promise<void> | void;
  /** Close immediately, without waiting for a hand boundary. */
  closeTable(tableId: TableId): Promise<void> | void;
  tableIds(): TableId[];
  inflightHands(): number;
}

/** No-op host: real scaffolding that "works today" and is used in tests. */
export class NoopTableHost implements TableHost {
  private readonly tables = new Set<TableId>();
  openTable(tableId: TableId): void {
    this.tables.add(tableId);
  }
  drainTable(tableId: TableId): void {
    this.tables.delete(tableId);
  }
  closeTable(tableId: TableId): void {
    this.tables.delete(tableId);
  }
  tableIds(): TableId[] {
    return [...this.tables];
  }
  inflightHands(): number {
    return 0;
  }
}

export interface ShardWorkerRuntimeOptions {
  workerId: WorkerId;
  host: TableHost;
  /** Callback to deliver a message to the manager. */
  send: (msg: WorkerToManager) => void;
  /** Heartbeat cadence in ms (0 disables the internal timer). */
  heartbeatMs?: number;
}

export class ShardWorkerRuntime {
  private readonly workerId: WorkerId;
  private readonly host: TableHost;
  private readonly send: (msg: WorkerToManager) => void;
  private readonly heartbeatMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(opts: ShardWorkerRuntimeOptions) {
    this.workerId = opts.workerId;
    this.host = opts.host;
    this.send = opts.send;
    this.heartbeatMs = opts.heartbeatMs ?? 2000;
  }

  /** Announce readiness and start the heartbeat. Call once after construction. */
  begin(): void {
    this.send({ type: 'READY', workerId: this.workerId });
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), this.heartbeatMs);
      // Don't keep the event loop alive purely for heartbeats.
      (this.heartbeatTimer as { unref?: () => void }).unref?.();
    }
  }

  private emitHeartbeat(): void {
    this.send({
      type: 'HEARTBEAT',
      workerId: this.workerId,
      tableCount: this.host.tableIds().length,
      inflightHands: this.host.inflightHands(),
    });
  }

  /** Handle one message from the manager. */
  async handle(msg: ManagerToWorker): Promise<void> {
    switch (msg.type) {
      case 'ASSIGN': {
        try {
          await this.host.openTable(msg.tableId);
          this.send({ type: 'ASSIGNED', workerId: this.workerId, tableId: msg.tableId });
        } catch (err) {
          this.send({
            type: 'ERROR',
            workerId: this.workerId,
            tableId: msg.tableId,
            message: errMsg(err),
          });
        }
        return;
      }
      case 'UNASSIGN': {
        try {
          await this.host.closeTable(msg.tableId);
          this.send({ type: 'UNASSIGNED', workerId: this.workerId, tableId: msg.tableId });
        } catch (err) {
          this.send({
            type: 'ERROR',
            workerId: this.workerId,
            tableId: msg.tableId,
            message: errMsg(err),
          });
        }
        return;
      }
      case 'DRAIN': {
        this.draining = true;
        // Snapshot first: drainTable mutates the host's table set.
        const tables = this.host.tableIds();
        for (const t of tables) {
          try {
            await this.host.drainTable(t);
            this.send({ type: 'TABLE_CLOSED', workerId: this.workerId, tableId: t });
          } catch (err) {
            this.send({
              type: 'ERROR',
              workerId: this.workerId,
              tableId: t,
              message: errMsg(err),
            });
          }
        }
        this.send({ type: 'DRAINED', workerId: this.workerId });
        return;
      }
      case 'PING': {
        this.send({ type: 'PONG', workerId: this.workerId, nonce: msg.nonce });
        return;
      }
      case 'SHUTDOWN': {
        this.stop();
        return;
      }
    }
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** Stop the heartbeat timer. Does not close tables (SHUTDOWN follows DRAIN). */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
