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

import type {
  ManagerToWorker,
  WorkerToManager,
  WorkerId,
  WorkerGeneration,
  OwnershipEpoch,
  TableId,
  TableLease,
  TableCloseFailure,
} from './protocol.js';

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
  workerGeneration: WorkerGeneration;
  host: TableHost;
  /** Callback to deliver a message to the manager. */
  send: (msg: WorkerToManager) => void;
  /** Heartbeat cadence in ms (0 disables the internal timer). */
  heartbeatMs?: number;
}

export class ShardWorkerRuntime {
  private readonly workerId: WorkerId;
  private readonly workerGeneration: WorkerGeneration;
  private readonly host: TableHost;
  private readonly send: (msg: WorkerToManager) => void;
  private readonly heartbeatMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private readonly tableLeases = new Map<
    TableId,
    { ownershipEpoch: OwnershipEpoch; state: 'opening' | 'active' | 'released' | 'failed' }
  >();
  private readonly tableOperations = new Map<TableId, Promise<void>>();
  private drainOperations: Promise<void> = Promise.resolve();

  constructor(opts: ShardWorkerRuntimeOptions) {
    this.workerId = opts.workerId;
    this.workerGeneration = opts.workerGeneration;
    this.host = opts.host;
    this.send = opts.send;
    this.heartbeatMs = opts.heartbeatMs ?? 2000;
  }

  /** Announce readiness and start the heartbeat. Call once after construction. */
  begin(): void {
    this.send({
      type: 'READY',
      workerId: this.workerId,
      workerGeneration: this.workerGeneration,
    });
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
      workerGeneration: this.workerGeneration,
      tableCount: this.host.tableIds().length,
      inflightHands: this.host.inflightHands(),
    });
  }

  /** Handle one message from the manager. */
  async handle(msg: ManagerToWorker): Promise<void> {
    // A channel can deliver buffered messages after a worker id has been reused.
    // Never let a command for another incarnation touch this host.
    if (msg.workerGeneration !== this.workerGeneration) return;

    switch (msg.type) {
      case 'ASSIGN': {
        if (this.draining) {
          this.sendOperationError('ASSIGN', msg, 'worker is draining');
          return;
        }
        return this.runTableOperation(msg.tableId, async () => {
          if (this.draining) {
            this.sendOperationError('ASSIGN', msg, 'worker is draining');
            return;
          }
          const current = this.tableLeases.get(msg.tableId);
          if (current?.ownershipEpoch === msg.ownershipEpoch && current.state === 'active') {
            this.send({
              type: 'ASSIGNED',
              workerId: this.workerId,
              workerGeneration: this.workerGeneration,
              tableId: msg.tableId,
              ownershipEpoch: msg.ownershipEpoch,
            });
            return;
          }
          if (current && msg.ownershipEpoch <= current.ownershipEpoch) {
            this.sendOperationError(
              'ASSIGN',
              msg,
              `stale ownership epoch ${msg.ownershipEpoch}; latest is ${current.ownershipEpoch}`
            );
            return;
          }
          if (current?.state === 'active' || current?.state === 'opening') {
            this.sendOperationError(
              'ASSIGN',
              msg,
              `table still owns epoch ${current.ownershipEpoch}; UNASSIGN must succeed first`
            );
            return;
          }

          this.tableLeases.set(msg.tableId, {
            ownershipEpoch: msg.ownershipEpoch,
            state: 'opening',
          });
          try {
            await this.host.openTable(msg.tableId);
            if (!this.host.tableIds().includes(msg.tableId)) {
              throw new Error('openTable returned without exposing the table as owned');
            }
            this.tableLeases.set(msg.tableId, {
              ownershipEpoch: msg.ownershipEpoch,
              state: 'active',
            });
            this.send({
              type: 'ASSIGNED',
              workerId: this.workerId,
              workerGeneration: this.workerGeneration,
              tableId: msg.tableId,
              ownershipEpoch: msg.ownershipEpoch,
            });
          } catch (err) {
            this.tableLeases.set(msg.tableId, {
              ownershipEpoch: msg.ownershipEpoch,
              state: 'failed',
            });
            this.sendOperationError('ASSIGN', msg, errMsg(err));
          }
        });
      }
      case 'UNASSIGN': {
        return this.runTableOperation(msg.tableId, async () => {
          const current = this.tableLeases.get(msg.tableId);
          if (current?.ownershipEpoch === msg.ownershipEpoch && current.state === 'released') {
            this.send({
              type: 'UNASSIGNED',
              workerId: this.workerId,
              workerGeneration: this.workerGeneration,
              tableId: msg.tableId,
              ownershipEpoch: msg.ownershipEpoch,
            });
            return;
          }
          if (!current || current.ownershipEpoch !== msg.ownershipEpoch) {
            this.sendOperationError(
              'UNASSIGN',
              msg,
              `ownership epoch ${msg.ownershipEpoch} is not active`
            );
            return;
          }
          if (current.state !== 'active') {
            this.sendOperationError(
              'UNASSIGN',
              msg,
              `ownership epoch ${msg.ownershipEpoch} is ${current.state}`
            );
            return;
          }
          try {
            await this.host.closeTable(msg.tableId);
            if (this.host.tableIds().includes(msg.tableId)) {
              throw new Error('closeTable returned while the table is still owned');
            }
            this.tableLeases.set(msg.tableId, {
              ownershipEpoch: msg.ownershipEpoch,
              state: 'released',
            });
            this.send({
              type: 'UNASSIGNED',
              workerId: this.workerId,
              workerGeneration: this.workerGeneration,
              tableId: msg.tableId,
              ownershipEpoch: msg.ownershipEpoch,
            });
          } catch (err) {
            this.sendOperationError('UNASSIGN', msg, errMsg(err));
          }
        });
      }
      case 'DRAIN': {
        this.draining = true;
        const operation = this.drainOperations
          .catch(() => undefined)
          .then(() => this.handleDrain(msg));
        this.drainOperations = operation.catch(() => undefined);
        return operation;
      }
      case 'PING': {
        this.send({
          type: 'PONG',
          workerId: this.workerId,
          workerGeneration: this.workerGeneration,
          nonce: msg.nonce,
        });
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

  /**
   * Definitively fence the in-process fallback. A real worker-thread terminate
   * kills its event loop; the inline channel must explicitly close every host
   * table to provide the same no-duplicate-dealer guarantee.
   */
  async terminate(): Promise<void> {
    this.draining = true;
    this.stop();
    await Promise.all([...this.tableOperations.values()]);
    const failures: unknown[] = [];
    for (const tableId of this.host.tableIds()) {
      try {
        await this.host.closeTable(tableId);
        if (this.host.tableIds().includes(tableId)) {
          throw new Error('closeTable returned while the table is still owned');
        }
        const lease = this.tableLeases.get(tableId);
        if (lease) this.tableLeases.set(tableId, { ...lease, state: 'released' });
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'inline shard worker could not close every table');
    }
  }

  private runTableOperation(tableId: TableId, operation: () => Promise<void>): Promise<void> {
    const previous = this.tableOperations.get(tableId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.catch(() => undefined);
    this.tableOperations.set(tableId, settled);
    void settled
      .then(() => {
        if (this.tableOperations.get(tableId) === settled) this.tableOperations.delete(tableId);
      })
      .catch(() => undefined);
    return current;
  }

  private async handleDrain(msg: Extract<ManagerToWorker, { type: 'DRAIN' }>): Promise<void> {
    // Commands already accepted before DRAIN must settle before its exact lease
    // manifest is evaluated. New ASSIGNs are rejected synchronously by draining.
    await Promise.all([...this.tableOperations.values()]);

    const closedTables: TableLease[] = [];
    const failedTables: TableCloseFailure[] = [];
    const requested = new Set(msg.tables.map((table) => table.tableId));

    for (const lease of msg.tables) {
      await this.runTableOperation(lease.tableId, async () => {
        const current = this.tableLeases.get(lease.tableId);
        if (current?.ownershipEpoch === lease.ownershipEpoch && current.state === 'released') {
          closedTables.push(lease);
          this.sendTableClosed(msg.drainId, lease);
          return;
        }
        if (
          !current ||
          current.ownershipEpoch !== lease.ownershipEpoch ||
          current.state !== 'active'
        ) {
          const message = !current
            ? 'table has no worker-side ownership lease'
            : `expected active epoch ${lease.ownershipEpoch}; found ${current.ownershipEpoch} (${current.state})`;
          failedTables.push({ ...lease, message });
          this.sendOperationError('DRAIN', lease, message, msg.drainId);
          return;
        }

        try {
          await this.host.drainTable(lease.tableId);
          if (this.host.tableIds().includes(lease.tableId)) {
            throw new Error('drainTable returned while the table is still owned');
          }
          this.tableLeases.set(lease.tableId, {
            ownershipEpoch: lease.ownershipEpoch,
            state: 'released',
          });
          closedTables.push(lease);
          this.sendTableClosed(msg.drainId, lease);
        } catch (err) {
          const message = errMsg(err);
          failedTables.push({ ...lease, message });
          this.sendOperationError('DRAIN', lease, message, msg.drainId);
        }
      });
    }

    // A worker with an active table absent from the manager's lease manifest is
    // split-brain evidence. Retain it and fail the drain instead of silently
    // terminating or handing the same table to another worker.
    for (const [tableId, current] of this.tableLeases) {
      if (current.state !== 'active' || requested.has(tableId)) continue;
      const failure = {
        tableId,
        ownershipEpoch: current.ownershipEpoch,
        message: 'active worker-side lease was absent from the drain manifest',
      };
      failedTables.push(failure);
      this.sendOperationError('DRAIN', failure, failure.message, msg.drainId);
    }

    for (const tableId of this.host.tableIds()) {
      if (this.tableLeases.get(tableId)?.state === 'active') continue;
      const failure = {
        tableId,
        ownershipEpoch: this.tableLeases.get(tableId)?.ownershipEpoch ?? 0,
        message: 'host owns a table without an active ownership lease',
      };
      failedTables.push(failure);
      this.sendOperationError('DRAIN', failure, failure.message, msg.drainId);
    }

    this.send({
      type: 'DRAINED',
      workerId: this.workerId,
      workerGeneration: this.workerGeneration,
      drainId: msg.drainId,
      closedTables,
      failedTables,
    });
  }

  private sendTableClosed(drainId: string, lease: TableLease): void {
    this.send({
      type: 'TABLE_CLOSED',
      workerId: this.workerId,
      workerGeneration: this.workerGeneration,
      drainId,
      ...lease,
    });
  }

  private sendOperationError(
    operation: 'ASSIGN' | 'UNASSIGN' | 'DRAIN',
    lease: TableLease,
    message: string,
    drainId?: string
  ): void {
    this.send({
      type: 'ERROR',
      workerId: this.workerId,
      workerGeneration: this.workerGeneration,
      operation,
      tableId: lease.tableId,
      ownershipEpoch: lease.ownershipEpoch,
      drainId,
      message,
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
