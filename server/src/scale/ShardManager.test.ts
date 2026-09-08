import { describe, it, expect } from 'vitest';
import {
  DrainFailedError,
  InProcessShardManager,
  InlineWorkerFactory,
  type TableHost,
  type WorkerChannel,
  type WorkerFactory,
} from './ShardManager.js';
import { TableRouter } from './TableRouter.js';
import type { ManagerToWorker, ShardWorkerData, TableId, WorkerToManager } from './protocol.js';

/**
 * MockTableHost simulates a worker's engine set. drainTable resolves on the next
 * tick to model "finish the in-flight hand, then close" without real poker logic.
 */
class MockTableHost implements TableHost {
  readonly tables = new Set<TableId>();
  private inflight = 0;
  drainCalls: TableId[] = [];
  openCalls: TableId[] = [];
  readonly closeFailures = new Set<TableId>();
  readonly drainFailures = new Set<TableId>();

  async openTable(id: TableId): Promise<void> {
    this.openCalls.push(id);
    this.tables.add(id);
  }
  async drainTable(id: TableId): Promise<void> {
    this.drainCalls.push(id);
    // simulate finishing the current hand asynchronously
    await Promise.resolve();
    if (this.drainFailures.has(id)) throw new Error(`cannot drain ${id}`);
    this.tables.delete(id);
  }
  async closeTable(id: TableId): Promise<void> {
    if (this.closeFailures.has(id)) throw new Error(`cannot close ${id}`);
    this.tables.delete(id);
  }
  tableIds(): TableId[] {
    return [...this.tables];
  }
  setInflight(n: number): void {
    this.inflight = n;
  }
  inflightHands(): number {
    return this.inflight;
  }
}

class ControlledChannel implements WorkerChannel {
  readonly posted: ManagerToWorker[] = [];
  autoAssign = true;
  autoPong = true;
  terminated = false;
  terminateError: Error | null = null;
  private messageListener: ((message: WorkerToManager) => void) | null = null;
  private exitListener: ((code: number) => void) | null = null;

  constructor(readonly data: ShardWorkerData) {}

  get id(): string {
    return this.data.workerId;
  }

  begin(): void {
    this.emit({
      type: 'READY',
      workerId: this.id,
      workerGeneration: this.data.workerGeneration,
    });
  }

  postMessage(message: ManagerToWorker): void {
    this.posted.push(message);
    if (message.type === 'PING' && this.autoPong) {
      queueMicrotask(() =>
        this.emit({
          type: 'PONG',
          workerId: this.id,
          workerGeneration: this.data.workerGeneration,
          nonce: message.nonce,
        })
      );
    }
    if (message.type === 'ASSIGN' && this.autoAssign) {
      queueMicrotask(() =>
        this.emit({
          type: 'ASSIGNED',
          workerId: this.id,
          workerGeneration: this.data.workerGeneration,
          tableId: message.tableId,
          ownershipEpoch: message.ownershipEpoch,
        })
      );
    }
    if (message.type === 'UNASSIGN') {
      queueMicrotask(() =>
        this.emit({
          type: 'UNASSIGNED',
          workerId: this.id,
          workerGeneration: this.data.workerGeneration,
          tableId: message.tableId,
          ownershipEpoch: message.ownershipEpoch,
        })
      );
    }
    if (message.type === 'DRAIN') {
      queueMicrotask(() => {
        for (const lease of message.tables) {
          this.emit({
            type: 'TABLE_CLOSED',
            workerId: this.id,
            workerGeneration: this.data.workerGeneration,
            drainId: message.drainId,
            ...lease,
          });
        }
        this.emit({
          type: 'DRAINED',
          workerId: this.id,
          workerGeneration: this.data.workerGeneration,
          drainId: message.drainId,
          closedTables: message.tables,
          failedTables: [],
        });
      });
    }
  }

  onMessage(listener: (message: WorkerToManager) => void): void {
    this.messageListener = listener;
  }

  onExit(listener: (code: number) => void): void {
    this.exitListener = listener;
  }

  async terminate(): Promise<void> {
    if (this.terminateError) throw this.terminateError;
    this.terminated = true;
  }

  emit(message: WorkerToManager): void {
    this.messageListener?.(message);
  }

  exit(code = 1): void {
    this.exitListener?.(code);
  }
}

class ControlledFactory implements WorkerFactory {
  readonly channels: ControlledChannel[] = [];

  create(data: ShardWorkerData): WorkerChannel {
    const channel = new ControlledChannel(data);
    this.channels.push(channel);
    queueMicrotask(() => channel.begin());
    return channel;
  }
}

function makeManager() {
  const hosts = new Map<string, MockTableHost>();
  const factory = new InlineWorkerFactory((workerId) => {
    const h = new MockTableHost();
    hosts.set(workerId, h);
    return h;
  });
  const mgr = new InProcessShardManager({
    factory,
    heartbeatMs: 50,
    ackTimeoutMs: 2000,
    drainTimeoutMs: 2000,
  });
  return { mgr, hosts };
}

const TABLES = Array.from({ length: 40 }, (_, i) => `table-${i}`);

describe('InProcessShardManager - lifecycle & routing', () => {
  it('spawns workers and reports health', async () => {
    const { mgr } = makeManager();
    await mgr.start();
    await mgr.spawnWorker('w1');
    await mgr.spawnWorker('w2');

    const health = mgr.listWorkers();
    expect(health.map((h) => h.workerId).sort()).toEqual(['w1', 'w2']);
    expect(health.every((h) => h.status === 'ready')).toBe(true);
    await mgr.shutdown();
  });

  it('rejects duplicate worker ids', async () => {
    const { mgr } = makeManager();
    await mgr.spawnWorker('w1');
    await expect(mgr.spawnWorker('w1')).rejects.toThrow();
    await mgr.shutdown();
  });

  it('assigns tables deterministically and tracks ownership', async () => {
    const { mgr, hosts } = makeManager();
    await mgr.spawnWorker('w1');
    await mgr.spawnWorker('w2');

    for (const t of TABLES) await mgr.assignTable(t);

    // every table owned by exactly one worker, and the host actually opened it
    for (const t of TABLES) {
      const owner = mgr.ownerOf(t);
      expect(owner).not.toBeNull();
      expect(hosts.get(owner!)!.tables.has(t)).toBe(true);
    }
    // both workers got some tables (rendezvous spread over 40 tables / 2 workers)
    const w1 = mgr.listWorkers().find((h) => h.workerId === 'w1')!;
    const w2 = mgr.listWorkers().find((h) => h.workerId === 'w2')!;
    expect(w1.tableCount + w2.tableCount).toBe(TABLES.length);
    expect(w1.tableCount).toBeGreaterThan(0);
    expect(w2.tableCount).toBeGreaterThan(0);

    // assigning again is a no-op (same routed owner)
    const owner = mgr.ownerOf(TABLES[0])!;
    const again = await mgr.assignTable(TABLES[0]);
    expect(again).toBe(owner);

    await mgr.shutdown();
  });

  it('throws when assigning with no workers', async () => {
    const { mgr } = makeManager();
    await expect(mgr.assignTable('t1')).rejects.toThrow();
    await mgr.shutdown();
  });

  it('unassignTable releases ownership', async () => {
    const { mgr, hosts } = makeManager();
    await mgr.spawnWorker('w1');
    await mgr.assignTable('t1');
    const owner = mgr.ownerOf('t1')!;
    expect(hosts.get(owner)!.tables.has('t1')).toBe(true);

    await mgr.unassignTable('t1');
    expect(mgr.ownerOf('t1')).toBeNull();
    expect(hosts.get(owner)!.tables.has('t1')).toBe(false);
    await mgr.shutdown();
  });

  it('serializes concurrent assignment so one table opens under one epoch exactly once', async () => {
    const { mgr, hosts } = makeManager();
    await mgr.spawnWorker('w1');
    const owners = await Promise.all(
      Array.from({ length: 10 }, () => mgr.assignTable('one-table'))
    );
    expect(owners).toEqual(Array.from({ length: 10 }, () => 'w1'));
    expect(hosts.get('w1')!.openCalls).toEqual(['one-table']);
    expect(mgr.ownerOf('one-table')).toBe('w1');
    await mgr.shutdown();
  });
});

describe('InProcessShardManager - graceful drain + handoff (zero-downtime primitive)', () => {
  it('drains a worker, closes its tables via the hand-boundary path, and hands them to survivors', async () => {
    const { mgr, hosts } = makeManager();
    await mgr.spawnWorker('w1');
    await mgr.spawnWorker('w2');
    for (const t of TABLES) await mgr.assignTable(t);

    // Drain w1: only survivor is w2, so EVERYTHING w1 owned must move to w2.
    const owned = mgr
      .listWorkers()
      .find((h) => h.workerId === 'w1')!
      .tables.slice();
    expect(owned.length).toBeGreaterThan(0);

    const result = await mgr.drainWorker('w1');

    expect(result.timedOut).toBe(false);
    expect(result.workerId).toBe('w1');
    expect(result.closedTables.sort()).toEqual([...owned].sort());
    // drainTable was actually invoked for each owned table (hand-boundary close)
    expect(hosts.get('w1')!.drainCalls.sort()).toEqual([...owned].sort());

    // every reassigned table went to w2 and is now open there
    for (const move of result.reassigned) {
      expect(move.from).toBe('w1');
      expect(move.to).toBe('w2');
      expect(mgr.ownerOf(move.tableId)).toBe('w2');
      expect(hosts.get('w2')!.tables.has(move.tableId)).toBe(true);
    }
    expect(result.reassigned.map((m) => m.tableId).sort()).toEqual([...owned].sort());

    // w1 is gone; all 40 tables now live on w2
    expect(mgr.listWorkers().map((h) => h.workerId)).toEqual(['w2']);
    expect(mgr.listWorkers()[0].tableCount).toBe(TABLES.length);

    await mgr.shutdown();
  });

  it('reports to:null when draining the last worker (no survivor to receive tables)', async () => {
    const { mgr } = makeManager();
    await mgr.spawnWorker('only');
    for (const t of ['a', 'b', 'c']) await mgr.assignTable(t);

    const result = await mgr.drainWorker('only');
    expect(result.closedTables.sort()).toEqual(['a', 'b', 'c']);
    for (const m of result.reassigned) expect(m.to).toBeNull();
    expect(mgr.listWorkers()).toHaveLength(0);
    await mgr.shutdown();
  });

  it('a rolling deploy (spawn new, drain old) keeps every table owned throughout', async () => {
    const { mgr } = makeManager();
    await mgr.spawnWorker('old-1');
    await mgr.spawnWorker('old-2');
    for (const t of TABLES) await mgr.assignTable(t);

    // Bring up the new generation, then drain the old one worker at a time.
    await mgr.spawnWorker('new-1');
    await mgr.spawnWorker('new-2');
    await mgr.drainWorker('old-1');
    await mgr.drainWorker('old-2');

    const remaining = mgr
      .listWorkers()
      .map((h) => h.workerId)
      .sort();
    expect(remaining).toEqual(['new-1', 'new-2']);

    // no table was dropped — all still owned, and only by new workers
    for (const t of TABLES) {
      const owner = mgr.ownerOf(t);
      expect(remaining).toContain(owner!);
    }
    const total = mgr.listWorkers().reduce((s, h) => s + h.tableCount, 0);
    expect(total).toBe(TABLES.length);
    await mgr.shutdown();
  });

  it('healthCheck returns ready workers', async () => {
    const { mgr } = makeManager();
    await mgr.spawnWorker('w1');
    const health = await mgr.healthCheck();
    expect(health).toHaveLength(1);
    expect(health[0].status).toBe('ready');
    await mgr.shutdown();
  });
});

describe('InProcessShardManager - ownership fencing', () => {
  it('propagates an UNASSIGN failure and never opens the table on a second worker', async () => {
    const { mgr, hosts } = makeManager();
    await mgr.spawnWorker('w1');
    const routeWithTwo = new TableRouter(['w1', 'w2']);
    const tableId = Array.from({ length: 100 }, (_, index) => `move-${index}`).find(
      (id) => routeWithTwo.route(id) === 'w2'
    )!;
    await mgr.assignTable(tableId);
    hosts.get('w1')!.closeFailures.add(tableId);
    await mgr.spawnWorker('w2');

    await expect(mgr.assignTable(tableId)).rejects.toThrow(`cannot close ${tableId}`);
    expect(mgr.ownerOf(tableId)).toBe('w1');
    expect(hosts.get('w1')!.tables.has(tableId)).toBe(true);
    expect(hosts.get('w2')!.tables.has(tableId)).toBe(false);

    hosts.get('w1')!.closeFailures.delete(tableId);
    await expect(mgr.assignTable(tableId)).resolves.toBe('w2');
    expect(mgr.ownerOf(tableId)).toBe('w2');
    await mgr.shutdown();
  });

  it('fails a partial drain, retains failed leases, and only hands off verified closes', async () => {
    const { mgr, hosts } = makeManager();
    await mgr.spawnWorker('w1');
    await mgr.assignTable('good');
    await mgr.assignTable('bad');
    hosts.get('w1')!.drainFailures.add('bad');
    await mgr.spawnWorker('w2');

    let failure: DrainFailedError | null = null;
    try {
      await mgr.drainWorker('w1');
    } catch (error) {
      expect(error).toBeInstanceOf(DrainFailedError);
      failure = error as DrainFailedError;
    }
    expect(failure?.result.completed).toBe(false);
    expect(failure?.result.failedTables).toEqual([
      expect.objectContaining({ tableId: 'bad', message: 'cannot drain bad' }),
    ]);
    expect(failure?.result.closedTables).toEqual(['good']);
    expect(mgr.ownerOf('bad')).toBe('w1');
    expect(mgr.ownerOf('good')).toBe('w2');
    expect(mgr.listWorkers().find((worker) => worker.workerId === 'w1')?.status).toBe('draining');

    hosts.get('w1')!.drainFailures.delete('bad');
    const retry = await mgr.drainWorker('w1');
    expect(retry.completed).toBe(true);
    expect(retry.closedTables).toEqual(['bad']);
    expect(mgr.ownerOf('bad')).toBe('w2');
    expect(mgr.listWorkers().map((worker) => worker.workerId)).toEqual(['w2']);
    await mgr.shutdown();
  });

  it('ignores stale generations and stale epochs, then releases ownership on worker exit', async () => {
    const factory = new ControlledFactory();
    const mgr = new InProcessShardManager({ factory, ackTimeoutMs: 500, heartbeatMs: 1000 });
    await mgr.spawnWorker('same-id');
    const oldChannel = factory.channels[0];
    oldChannel.exit(1);
    expect(mgr.listWorkers()).toHaveLength(0);

    await mgr.spawnWorker('same-id');
    const currentChannel = factory.channels[1];
    currentChannel.autoAssign = false;
    const assignment = mgr.assignTable('epoch-table');
    await Promise.resolve();
    await Promise.resolve();
    const command = currentChannel.posted.find(
      (message): message is Extract<ManagerToWorker, { type: 'ASSIGN' }> =>
        message.type === 'ASSIGN'
    )!;
    let settled = false;
    void assignment.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    oldChannel.emit({
      type: 'ASSIGNED',
      workerId: 'same-id',
      workerGeneration: oldChannel.data.workerGeneration,
      tableId: command.tableId,
      ownershipEpoch: command.ownershipEpoch,
    });
    currentChannel.emit({
      type: 'ASSIGNED',
      workerId: 'same-id',
      workerGeneration: currentChannel.data.workerGeneration,
      tableId: command.tableId,
      ownershipEpoch: command.ownershipEpoch + 1,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    currentChannel.emit({
      type: 'ASSIGNED',
      workerId: 'same-id',
      workerGeneration: currentChannel.data.workerGeneration,
      tableId: command.tableId,
      ownershipEpoch: command.ownershipEpoch,
    });
    await expect(assignment).resolves.toBe('same-id');
    oldChannel.exit(9);
    expect(mgr.ownerOf('epoch-table')).toBe('same-id');

    currentChannel.exit(2);
    expect(mgr.ownerOf('epoch-table')).toBeNull();
    expect(mgr.listWorkers()).toHaveLength(0);
    await mgr.shutdown();
  });

  it('rejects an in-flight assignment on exit and a late acknowledgement cannot resurrect it', async () => {
    const factory = new ControlledFactory();
    const mgr = new InProcessShardManager({ factory, ackTimeoutMs: 500, heartbeatMs: 1000 });
    await mgr.spawnWorker('worker');
    const channel = factory.channels[0];
    channel.autoAssign = false;
    const assignment = mgr.assignTable('table');
    await Promise.resolve();
    await Promise.resolve();
    const command = channel.posted.find(
      (message): message is Extract<ManagerToWorker, { type: 'ASSIGN' }> =>
        message.type === 'ASSIGN'
    )!;

    channel.exit(1);
    await expect(assignment).rejects.toThrow('worker exited with code 1');
    expect(mgr.ownerOf('table')).toBeNull();
    channel.emit({
      type: 'ASSIGNED',
      workerId: 'worker',
      workerGeneration: channel.data.workerGeneration,
      tableId: command.tableId,
      ownershipEpoch: command.ownershipEpoch,
    });
    expect(mgr.ownerOf('table')).toBeNull();
    expect(mgr.listWorkers()).toHaveLength(0);
    await mgr.shutdown();
  });

  it('fences an unhealthy process before removing its leases and routes only to READY workers', async () => {
    const factory = new ControlledFactory();
    const mgr = new InProcessShardManager({ factory, ackTimeoutMs: 20, heartbeatMs: 1000 });
    await mgr.spawnWorker('unhealthy');
    await mgr.assignTable('live-table');
    await mgr.spawnWorker('ready');
    factory.channels[0].autoPong = false;

    await mgr.healthCheck();
    expect(factory.channels[0].terminated).toBe(true);
    expect(mgr.listWorkers().map((worker) => worker.workerId)).toEqual(['ready']);
    expect(mgr.ownerOf('live-table')).toBeNull();
    await expect(mgr.assignTable('live-table')).resolves.toBe('ready');
    expect(mgr.ownerOf('live-table')).toBe('ready');
    await mgr.shutdown();
  });

  it('retains an unhealthy lease when process termination cannot prove the dealer stopped', async () => {
    const factory = new ControlledFactory();
    const mgr = new InProcessShardManager({ factory, ackTimeoutMs: 20, heartbeatMs: 1000 });
    await mgr.spawnWorker('unhealthy');
    await mgr.assignTable('live-table');
    await mgr.spawnWorker('ready');
    factory.channels[0].autoPong = false;
    factory.channels[0].terminateError = new Error('process would not terminate');

    await mgr.healthCheck();
    expect(mgr.listWorkers().find((worker) => worker.workerId === 'unhealthy')?.status).toBe(
      'unhealthy'
    );
    expect(mgr.ownerOf('live-table')).toBe('unhealthy');
    await expect(mgr.assignTable('live-table')).rejects.toThrow(
      'remains fenced to unhealthy (unhealthy)'
    );
    const readyAssignments = factory.channels[1].posted.filter(
      (message) => message.type === 'ASSIGN' && message.tableId === 'live-table'
    );
    expect(readyAssignments).toHaveLength(0);

    factory.channels[0].terminateError = null;
    factory.channels[0].exit(1);
    await mgr.shutdown();
  });
});
