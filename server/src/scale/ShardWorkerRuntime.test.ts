import { describe, expect, it } from 'vitest';
import { ShardWorkerRuntime, type TableHost } from './ShardWorkerRuntime.js';
import type { TableId, WorkerToManager } from './protocol.js';

class FencedHost implements TableHost {
  readonly tables = new Set<TableId>();
  readonly drainFailures = new Set<TableId>();

  openTable(tableId: TableId): void {
    this.tables.add(tableId);
  }

  drainTable(tableId: TableId): void {
    if (this.drainFailures.has(tableId)) throw new Error(`drain failed for ${tableId}`);
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

function makeRuntime() {
  const host = new FencedHost();
  const sent: WorkerToManager[] = [];
  const runtime = new ShardWorkerRuntime({
    workerId: 'worker',
    workerGeneration: 'generation-current',
    host,
    heartbeatMs: 0,
    send: (message) => sent.push(message),
  });
  return { runtime, host, sent };
}

describe('ShardWorkerRuntime ownership fencing', () => {
  it('ignores another worker generation and refuses a stale epoch without touching the table', async () => {
    const { runtime, host, sent } = makeRuntime();
    await runtime.handle({
      type: 'ASSIGN',
      workerGeneration: 'generation-stale',
      tableId: 'table',
      ownershipEpoch: 1,
    });
    expect(host.tableIds()).toEqual([]);
    expect(sent).toEqual([]);

    await runtime.handle({
      type: 'ASSIGN',
      workerGeneration: 'generation-current',
      tableId: 'table',
      ownershipEpoch: 2,
    });
    expect(host.tableIds()).toEqual(['table']);

    await runtime.handle({
      type: 'UNASSIGN',
      workerGeneration: 'generation-current',
      tableId: 'table',
      ownershipEpoch: 1,
    });
    expect(host.tableIds()).toEqual(['table']);
    expect(sent.at(-1)).toMatchObject({
      type: 'ERROR',
      operation: 'UNASSIGN',
      ownershipEpoch: 1,
    });

    await runtime.handle({
      type: 'UNASSIGN',
      workerGeneration: 'generation-current',
      tableId: 'table',
      ownershipEpoch: 2,
    });
    expect(host.tableIds()).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ type: 'UNASSIGNED', ownershipEpoch: 2 });
  });

  it('reports exact failed leases in DRAINED and keeps them active for a safe retry', async () => {
    const { runtime, host, sent } = makeRuntime();
    await runtime.handle({
      type: 'ASSIGN',
      workerGeneration: 'generation-current',
      tableId: 'table',
      ownershipEpoch: 7,
    });
    host.drainFailures.add('table');

    await runtime.handle({
      type: 'DRAIN',
      workerGeneration: 'generation-current',
      drainId: 'first',
      tables: [{ tableId: 'table', ownershipEpoch: 7 }],
    });
    expect(host.tableIds()).toEqual(['table']);
    expect(
      sent.find((message) => message.type === 'DRAINED' && message.drainId === 'first')
    ).toEqual({
      type: 'DRAINED',
      workerId: 'worker',
      workerGeneration: 'generation-current',
      drainId: 'first',
      closedTables: [],
      failedTables: [{ tableId: 'table', ownershipEpoch: 7, message: 'drain failed for table' }],
    });

    host.drainFailures.delete('table');
    await runtime.handle({
      type: 'DRAIN',
      workerGeneration: 'generation-current',
      drainId: 'retry',
      tables: [{ tableId: 'table', ownershipEpoch: 7 }],
    });
    expect(host.tableIds()).toEqual([]);
    expect(
      sent.find((message) => message.type === 'DRAINED' && message.drainId === 'retry')
    ).toEqual({
      type: 'DRAINED',
      workerId: 'worker',
      workerGeneration: 'generation-current',
      drainId: 'retry',
      closedTables: [{ tableId: 'table', ownershipEpoch: 7 }],
      failedTables: [],
    });
  });
});
