import { describe, expect, it, vi } from 'vitest';

// The pool clamps an explicit worker request to the host's logical CPUs
// (horseDecisionWorkerCount). The pool tests below ask for two workers to
// test routing, readiness and the fleet status, not the host; on a runner with
// fewer than four logical CPUs the clamp left one worker and those tests
// failed for a reason that is not theirs. The count policy itself is tested
// directly with explicit core counts.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, availableParallelism: () => 8 };
});
import type { HorseDecisionWorkerReady, HorseDecisionWorkerResponse } from './protocol.js';
import { HORSE_MIND_MIRROR_MAX_PENDING, type WorkerLike } from './client.js';
import { solverStoreIdentity } from '../../gto/SolverStoreIdentity.js';
import {
  DEFAULT_HORSE_DECISION_WORKERS,
  LiveHorseDecisionWorkerPool,
  MAX_HORSE_DECISION_WORKERS,
  horseDecisionShard,
  horseDecisionWorkerCount,
} from './lane.js';

/**
 * The lane is N clients and one routing rule. client.test.ts owns every FIFO,
 * deadline, CANCEL and ownership law of one client; these tests own only what
 * the lane adds: the count policy, the shard rule, that a table always meets
 * the same worker, that the status is the fleet's and that readiness and stop
 * cover every worker.
 */

class FakeWorker implements WorkerLike {
  readonly sent: any[] = [];
  terminateCalls = 0;
  private messageListener: ((message: HorseDecisionWorkerResponse) => void) | null = null;
  constructor(readonly index: number) {}
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  on(event: 'message', listener: (message: HorseDecisionWorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'message' | 'error' | 'exit', listener: unknown): this {
    if (event === 'message')
      this.messageListener = listener as (message: HorseDecisionWorkerResponse) => void;
    return this;
  }
  terminate(): Promise<number> {
    this.terminateCalls++;
    return Promise.resolve(0);
  }
  emit(message: unknown): void {
    this.messageListener?.(message as HorseDecisionWorkerResponse);
  }
  /** Answer every posted, unanswered ACK-shaped job in post order. */
  ackAll(): void {
    for (const job of this.sent) {
      if (job.type === 'OBSERVE_COMPLETED_HAND' && !job.__acked) {
        job.__acked = true;
        this.emit({
          type: 'ACK',
          requestId: job.requestId,
          generation: job.generation,
          fence: job.fence,
          operation: 'OBSERVE_COMPLETED_HAND',
        });
      }
    }
  }
}

const V31_DATASET = {
  id: '11111111-1111-4111-8111-111111111111',
  checksum: 'a'.repeat(64),
};

const ready = (overrides: Partial<HorseDecisionWorkerReady> = {}): HorseDecisionWorkerReady => ({
  type: 'READY',
  solverStores: { charts: 1, postflop: 2, postflopV31: 3, postflopV31Dataset: V31_DATASET },
  solverPolicyArtifact: {
    totalPolicies: 4,
    policyVersion: 'p.1',
    schemaSha256: 'b'.repeat(64),
  } as unknown as HorseDecisionWorkerReady['solverPolicyArtifact'],
  governor: {
    enabled: true,
    scale: 1,
    p50Ms: 10,
    p99Ms: 20,
    sampledAt: 1,
    throttledForS: 0,
    stale: false,
    timerLateMs: 0,
  },
  ...overrides,
});

function poolOf(count: number): { pool: LiveHorseDecisionWorkerPool; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const pool = new LiveHorseDecisionWorkerPool({
    workers: count,
    workerFactory: () => {
      const worker = new FakeWorker(workers.length);
      workers.push(worker);
      return worker;
    },
  });
  return { pool, workers };
}

const observation = (table: string, hand: number) => ({
  generation: hand,
  fence: `${table}:${hand}:lease:observe`,
  handKey: `${table}:${hand}`,
  bigBlind: 2,
  actions: [],
});

describe('horseDecisionWorkerCount', () => {
  it('runs two workers on a two-core host only where they yield to the main loop', () => {
    expect(horseDecisionWorkerCount({ cores: 4, canYield: true })).toBe(2);
    expect(horseDecisionWorkerCount({ cores: 3, canYield: true })).toBe(1);
    expect(horseDecisionWorkerCount({ cores: 2, canYield: true })).toBe(1);
    expect(horseDecisionWorkerCount({ cores: 4, canYield: false })).toBe(1);
    expect(horseDecisionWorkerCount({ requested: '3', cores: 4, canYield: true })).toBe(2);
    expect(horseDecisionWorkerCount({ requested: '1', cores: 4, canYield: true })).toBe(1);
  });

  it('runs one yielding worker per physical core, never fewer than two (2026-10-16)', () => {
    // The engine host: eight logical CPUs on four EPYC Milan cores. Three.
    expect(horseDecisionWorkerCount({ cores: 8, canYield: true })).toBe(4);
    expect(horseDecisionWorkerCount({ cores: 6, canYield: true })).toBe(3);
    expect(horseDecisionWorkerCount({ cores: 10, canYield: true })).toBe(5);
    expect(horseDecisionWorkerCount({ cores: 16, canYield: true })).toBe(8);
    expect(horseDecisionWorkerCount({ cores: 32, canYield: true })).toBe(
      MAX_HORSE_DECISION_WORKERS
    );
  });

  it('never defaults to more shards than the journal disk can hold, nor bounds an explicit request', () => {
    expect(horseDecisionWorkerCount({ cores: 8, canYield: true, journalShards: 3 })).toBe(3);
    expect(horseDecisionWorkerCount({ cores: 8, canYield: true, journalShards: 5 })).toBe(4);
    expect(horseDecisionWorkerCount({ cores: 8, canYield: true, journalShards: 2 })).toBe(2);
    expect(horseDecisionWorkerCount({ cores: 8, canYield: true, journalShards: 1 })).toBe(1);
    expect(horseDecisionWorkerCount({ cores: 8, journalShards: 1 })).toBe(1);
    // No journal, or no reading of it: the CPU rule alone.
    for (const journalShards of [undefined, 0, -1, 1.5, Number.NaN])
      expect(horseDecisionWorkerCount({ cores: 8, canYield: true, journalShards })).toBe(4);
    // The operator who sets HORSE_DECISION_WORKERS sizes the journal too.
    expect(
      horseDecisionWorkerCount({ requested: '4', cores: 8, canYield: true, journalShards: 2 })
    ).toBe(4);
  });

  it('defaults by physical cores at two threads each where a worker cannot yield', () => {
    expect(DEFAULT_HORSE_DECISION_WORKERS).toBe(2);
    // engine-01: four logical CPUs on two EPYC Milan cores. One worker.
    expect(horseDecisionWorkerCount({ cores: 4 })).toBe(1);
    expect(horseDecisionWorkerCount({ cores: 5 })).toBe(1);
    expect(horseDecisionWorkerCount({ cores: 6 })).toBe(2);
    expect(horseDecisionWorkerCount({ cores: 8 })).toBe(2);
    expect(horseDecisionWorkerCount({ cores: 16 })).toBe(2);
    expect(horseDecisionWorkerCount({ cores: 3 })).toBe(1);
    expect(horseDecisionWorkerCount({ cores: 2 })).toBe(1);
    expect(horseDecisionWorkerCount({ cores: 1 })).toBe(1);
    expect(horseDecisionWorkerCount({ cores: 0 })).toBe(1);
    expect(horseDecisionWorkerCount({ cores: Number.NaN })).toBe(1);
  });

  it('honours HORSE_DECISION_WORKERS up to the logical CPUs left after the main loop and one equity worker', () => {
    expect(horseDecisionWorkerCount({ requested: '3', cores: 8 })).toBe(3);
    expect(horseDecisionWorkerCount({ requested: ' 3 ', cores: 8 })).toBe(3);
    expect(horseDecisionWorkerCount({ requested: 3, cores: 8 })).toBe(3);
    // An operator who knows the host may run two on engine-01; never three.
    expect(horseDecisionWorkerCount({ requested: '2', cores: 4 })).toBe(2);
    expect(horseDecisionWorkerCount({ requested: '3', cores: 4 })).toBe(2);
    expect(horseDecisionWorkerCount({ requested: '1', cores: 8 })).toBe(1);
    expect(
      horseDecisionWorkerCount({ requested: String(MAX_HORSE_DECISION_WORKERS), cores: 32 })
    ).toBe(MAX_HORSE_DECISION_WORKERS);
  });

  it('treats a malformed or out-of-range request as unset', () => {
    for (const requested of [
      '',
      'two',
      '0',
      '-1',
      '1.5',
      '99',
      null,
      undefined,
      0,
      99,
      Number.NaN,
    ]) {
      expect(horseDecisionWorkerCount({ requested, cores: 8 })).toBe(2);
      expect(horseDecisionWorkerCount({ requested, cores: 4 })).toBe(1);
    }
  });
});

describe('the boot journal walk may be skipped only when it cannot change the count (2026-10-24)', () => {
  it('gives the same worker count for any capacity at or above the maximum', () => {
    for (let cores = 1; cores <= 64; cores++) {
      for (const canYield of [true, false]) {
        for (const requested of [undefined, '2', '6', '12']) {
          const atMax = horseDecisionWorkerCount({
            requested,
            cores,
            canYield,
            journalShards: MAX_HORSE_DECISION_WORKERS,
          });
          for (const measured of [MAX_HORSE_DECISION_WORKERS + 1, 20, 25, 200]) {
            expect(
              horseDecisionWorkerCount({ requested, cores, canYield, journalShards: measured })
            ).toBe(atMax);
          }
        }
      }
    }
  });
});

describe('horseDecisionShard', () => {
  it('keys on the table id in front of the first colon', () => {
    const table = '3c00d4d0-5d98-44de-ad36-cd683001d32a';
    const shard = horseDecisionShard(`${table}:1:2:lease:token`, 4);
    expect(horseDecisionShard(`${table}:9:5:other:x`, 4)).toBe(shard);
    expect(horseDecisionShard(`${table}:12:pineapple-discard:1`, 4)).toBe(shard);
    expect(horseDecisionShard(`${table}:12:lease:observe`, 4)).toBe(shard);
    expect(horseDecisionShard(table, 4)).toBe(shard);
  });

  it('is 0 for one worker and stable across calls', () => {
    expect(horseDecisionShard('a:b', 1)).toBe(0);
    expect(horseDecisionShard('a:b', 0)).toBe(0);
    expect(horseDecisionShard('worker:status', 3)).toBe(horseDecisionShard('worker:status', 3));
    expect(horseDecisionShard('', 3)).toBe(horseDecisionShard('', 3));
    expect(horseDecisionShard('', 3)).toBeLessThan(3);
  });

  it('spreads uuid table ids across the workers', () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) {
      const hex = (n: number) => n.toString(16).padStart(8, '0');
      const table = `${hex(i * 2654435761)}-${hex(i * 40503)}-4${hex(i).slice(1)}-8${hex(i * 7).slice(1)}-${hex(i * 13)}${hex(i * 17).slice(0, 4)}`;
      counts[horseDecisionShard(`${table}:1`, 3)]! += 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });
});

describe('LiveHorseDecisionWorkerPool', () => {
  it('starts one client per worker and is ready only when every worker is', async () => {
    const { pool, workers } = poolOf(2);
    expect(workers).toHaveLength(2);
    expect(pool.workerCount).toBe(2);
    let settled = false;
    void pool.ready().then(() => (settled = true));
    workers[0]!.emit(ready());
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pool.status().phase).toBe('starting');
    workers[1]!.emit(ready());
    await expect(pool.ready()).resolves.toMatchObject({ solverStores: { charts: 1 } });
    expect(pool.status().phase).toBe('ready');
    expect(pool.status().workerCount).toBe(2);
  });

  it('refuses readiness when a worker loaded a different solver corpus', async () => {
    const { pool, workers } = poolOf(2);
    workers[0]!.emit(ready());
    workers[1]!.emit(
      ready({
        solverStores: { charts: 1, postflop: 99, postflopV31: 3, postflopV31Dataset: V31_DATASET },
      })
    );
    await expect(pool.ready()).rejects.toThrow('worker 1 loaded a different solver corpus');
    expect(workers.every((worker) => worker.sent.some((m) => m.type === 'SHUTDOWN'))).toBe(true);
  });

  it.each(['charts', 'postflop'] as const)(
    'refuses equal-count different %s content',
    async (store) => {
      const { pool, workers } = poolOf(2);
      const original = {
        charts: solverStoreIdentity(new Map([['chart', { frequency: 0.5 }]]), null),
        postflop: solverStoreIdentity(new Map([['node', { equity: 0.5 }]]), null),
      };
      const changed = {
        ...original,
        [store]: solverStoreIdentity(
          new Map([
            [
              store === 'charts' ? 'chart' : 'node',
              store === 'charts' ? { frequency: 0.6 } : { equity: 0.6 },
            ],
          ]),
          null
        ),
      };
      workers[0]!.emit(ready({ solverStoreIdentity: original }));
      workers[1]!.emit(ready({ solverStoreIdentity: changed }));
      await expect(pool.ready()).rejects.toThrow('worker 1 loaded a different solver corpus');
      expect(workers.every((worker) => worker.sent.some((m) => m.type === 'SHUTDOWN'))).toBe(true);
    }
  );

  it('accepts identical content with an unknown source revision', async () => {
    const { pool, workers } = poolOf(2);
    const content = new Map([['row', { frequency: 0.5 }]]);
    const unknown = solverStoreIdentity(content, null);
    const known = solverStoreIdentity(content, '2026-10-12T00:00:00.000Z');
    workers[0]!.emit(ready({ solverStoreIdentity: { charts: unknown, postflop: unknown } }));
    workers[1]!.emit(ready({ solverStoreIdentity: { charts: known, postflop: known } }));
    await expect(pool.ready()).resolves.toBeDefined();
  });

  it.each(['missing', 'malformed', 'revision'] as const)(
    'refuses %s corpus identity beside a loaded peer',
    async (kind) => {
      const { pool, workers } = poolOf(2);
      const content = new Map([['row', { frequency: 0.5 }]]);
      const original = solverStoreIdentity(content, '2026-10-12T00:00:00.000Z');
      const other =
        kind === 'revision'
          ? solverStoreIdentity(content, '2026-10-12T01:00:00.000Z')
          : { ...original, digest: 'invalid' };
      workers[0]!.emit(ready({ solverStoreIdentity: { charts: original, postflop: original } }));
      workers[1]!.emit(
        ready({
          solverStoreIdentity:
            kind === 'missing' ? undefined : { charts: other, postflop: original },
        })
      );
      await expect(pool.ready()).rejects.toThrow('worker 1 loaded a different solver corpus');
      expect(workers.every((worker) => worker.sent.some((m) => m.type === 'SHUTDOWN'))).toBe(true);
    }
  );

  it('routes every job for one table to the same worker, in order', async () => {
    const { pool, workers } = poolOf(2);
    for (const worker of workers) worker.emit(ready());
    await pool.ready();
    const tables = Array.from({ length: 40 }, (_, i) => `table-${i}-${(i * 7919).toString(16)}`);
    const owners = new Map<string, number>();
    for (const table of tables) {
      for (const hand of [1, 2, 3]) {
        const ack = pool.observeCompletedHand(observation(table, hand) as any);
        // Dispatch is synchronous below maxInFlight, so every shard has it now:
        // the owner to observe and journal, the other to learn (2026-10-16).
        const posted = workers.map((w) =>
          w.sent.filter(
            (m) => m.type === 'OBSERVE_COMPLETED_HAND' && m.fence.startsWith(`${table}:`)
          )
        );
        expect(posted.every((jobs) => jobs.length === hand)).toBe(true);
        const owner = horseDecisionShard(`${table}:${hand}`, 2);
        if (owners.has(table)) expect(owners.get(table)).toBe(owner);
        owners.set(table, owner);
        // The owner's acknowledgement is the hand's; a mirror never holds it.
        workers[owner]!.ackAll();
        await ack;
        workers[1 - owner]!.ackAll();
      }
    }
    expect(new Set(owners.values()).size).toBe(2);
    const status = pool.status();
    expect(status.completedJobs).toBe(tables.length * 3 * 2);
    expect(status.workers.map((w) => w.completedJobs).reduce((a, b) => a + b, 0)).toBe(
      tables.length * 3 * 2
    );
    for (const worker of workers) {
      const fences = worker.sent
        .filter((m) => m.type === 'OBSERVE_COMPLETED_HAND')
        .map((m) => m.fence as string);
      for (const table of tables) {
        const mine = fences.filter((f) => f.startsWith(`${table}:`));
        if (mine.length) expect(mine).toEqual([1, 2, 3].map((h) => `${table}:${h}:lease:observe`));
      }
    }
  });

  it('reports the fleet: sums, the oldest wait, the worst phase and the most throttled governor', async () => {
    const { pool, workers } = poolOf(2);
    workers[0]!.emit(ready({ governor: { ...ready().governor, scale: 1 } }));
    workers[1]!.emit(ready({ governor: { ...ready().governor, scale: 0.4, p50Ms: 90 } }));
    await pool.ready();
    const status = pool.status();
    expect(status.maxInFlight).toBe(64);
    expect(status.governor?.scale).toBe(0.4);
    expect(status.governor?.p50Ms).toBe(90);
    expect(status.workers).toHaveLength(2);
    void pool.observeCompletedHand(observation('t-a', 1) as any).catch(() => undefined);
    void pool.observeCompletedHand(observation('t-b', 1) as any).catch(() => undefined);
    void pool.observeCompletedHand(observation('t-c', 1) as any).catch(() => undefined);
    const busy = pool.status();
    // Three hands, each on both shards (owner plus mirror).
    expect(busy.queueDepth).toBe(6);
    expect(busy.inFlightJobs).toBe(6);
    expect(busy.workers.map((w) => w.queueDepth).reduce((a, b) => a + b, 0)).toBe(6);
    workers[1]!.emit({ type: 'ERROR_UNKNOWN_PROTOCOL' } as never);
    expect(pool.status().phase).toBe('failed');
    expect(pool.status().lastError).not.toBeNull();
    expect(pool.status().workers[0]!.phase).toBe('ready');
  });

  it('holds the dispatch barrier on every shard for the whole callback', async () => {
    const { pool, workers } = poolOf(3);
    for (const worker of workers) worker.emit(ready());
    await pool.ready();
    const acks: Promise<unknown>[] = [];
    const returned = pool.runWithDispatchBarrier(() => {
      for (const table of ['x-1', 'x-2', 'x-3', 'x-4', 'x-5', 'x-6'])
        acks.push(pool.observeCompletedHand(observation(table, 1) as any));
      // Nothing was posted while the barrier held.
      expect(workers.every((w) => !w.sent.some((m) => m.type === 'OBSERVE_COMPLETED_HAND'))).toBe(
        true
      );
      return 'done';
    });
    expect(returned).toBe('done');
    expect(
      workers.reduce(
        (n, w) => n + w.sent.filter((m) => m.type === 'OBSERVE_COMPLETED_HAND').length,
        0
      )
    ).toBe(18);
    for (const worker of workers) worker.ackAll();
    await Promise.all(acks);
  });

  it('stops every worker and reports stopped', async () => {
    const { pool, workers } = poolOf(2);
    for (const worker of workers) worker.emit(ready());
    await pool.ready();
    const stopping = pool.stop();
    for (const worker of workers) {
      expect(worker.sent.some((m) => m.type === 'SHUTDOWN')).toBe(true);
      worker.emit({ type: 'STOPPED' } as never);
    }
    await stopping;
    expect(pool.status().phase).toBe('stopped');
    expect(workers.every((worker) => worker.terminateCalls === 1)).toBe(true);
  });
});

describe('ONE FLOOR, ONE READ: every shard learns every completed hand (2026-10-16)', () => {
  const TABLE = '10000000-0000-4000-8000-0000000000aa';
  const roster = { rosterDigest: 'r'.repeat(64) };

  it('sends the owner the hand as before and every other shard a mirror without the private roster', async () => {
    const { pool, workers } = poolOf(3);
    for (const worker of workers) worker.emit(ready());
    await pool.ready();
    const hand = { ...observation(TABLE, 1_000_001), acceptedActorRoster: roster };
    const ack = pool.observeCompletedHand(hand as any);
    const owner = horseDecisionShard(hand.fence, 3);
    for (const worker of workers) {
      const jobs = worker.sent.filter((m) => m.type === 'OBSERVE_COMPLETED_HAND');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].fence).toBe(hand.fence);
      expect(jobs[0].handKey).toBe(hand.handKey);
      if (worker.index === owner) expect(jobs[0].acceptedActorRoster).toEqual(roster);
      else expect(Object.hasOwn(jobs[0], 'acceptedActorRoster')).toBe(false);
    }
    workers[owner]!.ackAll();
    await expect(ack).resolves.toMatchObject({ type: 'ACK' });
  });

  it('a lost mirror never fails the hand', async () => {
    const { pool, workers } = poolOf(2);
    for (const worker of workers) worker.emit(ready());
    await pool.ready();
    const hand = observation(TABLE, 1_000_002);
    const owner = horseDecisionShard(hand.fence, 2);
    const ack = pool.observeCompletedHand(hand as any);
    workers[owner]!.ackAll();
    const mirror = workers[1 - owner]!.sent.find((m) => m.type === 'OBSERVE_COMPLETED_HAND');
    workers[1 - owner]!.emit({
      type: 'ERROR',
      requestId: mirror.requestId,
      generation: mirror.generation,
      fence: mirror.fence,
      message: 'refused',
      recoverable: true,
    });
    await expect(ack).resolves.toMatchObject({ type: 'ACK' });
  });

  it('bounds what a lagging shard holds: past the bound a mirror is shed, never queued', async () => {
    const { pool, workers } = poolOf(2);
    for (const worker of workers) worker.emit(ready());
    await pool.ready();
    const owner = horseDecisionShard(`${TABLE}:1`, 2);
    for (let i = 0; i < HORSE_MIND_MIRROR_MAX_PENDING + 40; i++)
      void pool
        .observeCompletedHand(observation(TABLE, 1_000_000 + i) as any)
        .catch(() => undefined);
    const status = pool.status();
    expect(status.workers[owner]!.queueDepth).toBe(HORSE_MIND_MIRROR_MAX_PENDING + 40);
    expect(status.workers[1 - owner]!.queueDepth).toBe(HORSE_MIND_MIRROR_MAX_PENDING);
    void pool.stop().catch(() => undefined);
  });
});
