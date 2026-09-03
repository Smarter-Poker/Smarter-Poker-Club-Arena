import { describe, it, expect } from 'vitest';
import { InProcessShardManager, InlineWorkerFactory, type TableHost } from './ShardManager.js';
import type { TableId } from './protocol.js';

/**
 * MockTableHost simulates a worker's engine set. drainTable resolves on the next
 * tick to model "finish the in-flight hand, then close" without real poker logic.
 */
class MockTableHost implements TableHost {
  readonly tables = new Set<TableId>();
  private inflight = 0;
  drainCalls: TableId[] = [];

  async openTable(id: TableId): Promise<void> {
    this.tables.add(id);
  }
  async drainTable(id: TableId): Promise<void> {
    this.drainCalls.push(id);
    // simulate finishing the current hand asynchronously
    await Promise.resolve();
    this.tables.delete(id);
  }
  async closeTable(id: TableId): Promise<void> {
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
