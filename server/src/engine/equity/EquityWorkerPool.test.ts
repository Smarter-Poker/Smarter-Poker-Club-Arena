import { Worker } from 'node:worker_threads';

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Card, CardRank, CardSuit } from '../../types.js';
import {
  EquityWorkerPool,
  EquityWorkerTimeoutError,
  EquityWorkerUnavailableError,
} from './EquityWorkerPool.js';
import type { EquityWorkerPoolOptions } from './EquityWorkerPool.js';
import { computeEquity } from './equityWorker.js';

const C = (rank: CardRank, suit: CardSuit): Card => ({ rank, suit });

class LoopbackEquityWorker {
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  constructor() {
    queueMicrotask(() => this.emit('message', { type: 'READY' }));
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  postMessage(message: any): void {
    queueMicrotask(() => {
      try {
        this.emit('message', {
          type: 'EQUITY_RESULT',
          id: message.id,
          equities: computeEquity(
            message.hands,
            message.board,
            message.deadCards,
            message.iters,
            message.opts,
            message.seed
          ),
        });
      } catch (error) {
        this.emit('message', { type: 'ERROR', id: message.id, error: String(error) });
      }
    });
  }

  unref(): void {}
  async terminate(): Promise<number> {
    return 0;
  }
  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

const pool = new EquityWorkerPool({ size: 1, workerFactory: () => new LoopbackEquityWorker() });
beforeAll(async () => {
  await pool.ready();
});
afterAll(async () => {
  await pool.shutdown();
});

describe('EquityWorkerPool.estimateEquity', () => {
  it('AA vs KK preflop ~ 0.82 / 0.18', async () => {
    const hands: Card[][] = [
      [C('A', 'spades'), C('A', 'hearts')],
      [C('K', 'spades'), C('K', 'diamonds')],
    ];
    const eq = await pool.estimateEquity(hands, [], [], 20000);
    expect(eq).toHaveLength(2);
    expect(eq[0]).toBeGreaterThan(0.79);
    expect(eq[0]).toBeLessThan(0.86);
    expect(eq[1]).toBeGreaterThan(0.14);
    expect(eq[1]).toBeLessThan(0.21);
    expect(eq[0] + eq[1]).toBeCloseTo(1, 5);
  });

  it('is deterministic per (seed, inputs)', async () => {
    const hands: Card[][] = [
      [C('A', 'spades'), C('K', 'spades')],
      [C('Q', 'hearts'), C('Q', 'clubs')],
    ];
    const a = await pool.estimateEquity(hands, [], [], 5000, {}, 123);
    const b = await pool.estimateEquity(hands, [], [], 5000, {}, 123);
    expect(a).toEqual(b);
  });

  it('a made hand on a complete board reads 100% (single deterministic eval)', async () => {
    // Hero flopped a set of aces vs KK on a dry, fully dealt board.
    const board: Card[] = [
      C('A', 'clubs'),
      C('7', 'diamonds'),
      C('2', 'hearts'),
      C('9', 'spades'),
      C('3', 'clubs'),
    ];
    const hands: Card[][] = [
      [C('A', 'spades'), C('A', 'hearts')],
      [C('K', 'spades'), C('K', 'diamonds')],
    ];
    const eq = await pool.estimateEquity(hands, board, [], 1000);
    expect(eq[0]).toBeCloseTo(1, 5);
    expect(eq[1]).toBeCloseTo(0, 5);
  });

  it('synchronous computeEquity matches the pool for the AA vs KK matchup', () => {
    const hands: Card[][] = [
      [C('A', 'spades'), C('A', 'hearts')],
      [C('K', 'spades'), C('K', 'diamonds')],
    ];
    const eq = computeEquity(hands, [], [], 20000, {}, 999);
    expect(eq[0]).toBeGreaterThan(0.79);
    expect(eq[0]).toBeLessThan(0.86);
  });
});

interface WorkerScript {
  autoReady?: boolean;
  computeMs?: number;
}

interface PostedOperation {
  id: number;
  type: string;
  seed?: number;
}

/**
 * A worker the test drives by hand on the fake clock: READY when told (or at
 * once, like a boot that succeeds), an answer when told (or a fixed compute
 * time after each dispatch), and an exit when told.
 */
class ScriptedEquityWorker {
  readonly sent: PostedOperation[] = [];
  terminateCalls = 0;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  private readonly computing = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly script: WorkerScript = {}) {
    if (script.autoReady) queueMicrotask(() => this.ready());
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  postMessage(message: PostedOperation): void {
    this.sent.push(message);
    if (this.script.computeMs === undefined) return;
    const done = setTimeout(() => {
      this.computing.delete(done);
      this.answer(message.id);
    }, this.script.computeMs);
    this.computing.add(done);
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    for (const done of this.computing) clearTimeout(done);
    this.computing.clear();
    return 0;
  }

  ready(): void {
    this.emit('message', { type: 'READY' });
  }

  /** Answer a posted operation (the latest by default) with a well-formed result. */
  answer(id = this.sent.at(-1)!.id): void {
    const operation = this.sent.find((message) => message.id === id)!;
    if (operation.type === 'INSURANCE_ALL') {
      this.emit('message', {
        type: 'INSURANCE_RESULT',
        id,
        components: [
          { equity: 82, strictLossPct: 18, pushPct: 0, exact: false, runouts: 6000 },
          { equity: 18, strictLossPct: 82, pushPct: 0, exact: false, runouts: 6000 },
        ],
      });
    } else {
      this.emit('message', { type: 'EQUITY_RESULT', id, equities: [0.82, 0.18] });
    }
  }

  exit(code = 1): void {
    this.emit('exit', code);
  }

  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function scriptedPool(
  options: Omit<EquityWorkerPoolOptions, 'size' | 'workerFactory'>,
  script: WorkerScript = {}
): { pool: EquityWorkerPool; workers: ScriptedEquityWorker[] } {
  const workers: ScriptedEquityWorker[] = [];
  const pool = new EquityWorkerPool({
    size: 1,
    readyTimeoutMs: 1_000,
    ...options,
    workerFactory: () => {
      const worker = new ScriptedEquityWorker(script);
      workers.push(worker);
      return worker;
    },
  });
  return { pool, workers };
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Observe every operation from the moment it is made; inspect it later. */
function outcome(operation: Promise<unknown>): Promise<Outcome> {
  return operation.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );
}

function timeoutStage(result: Outcome): string | undefined {
  if (result.ok) return undefined;
  expect(result.error).toBeInstanceOf(EquityWorkerTimeoutError);
  return (result.error as EquityWorkerTimeoutError).stage;
}

const HANDS: Card[][] = [
  [C('A', 'spades'), C('A', 'hearts')],
  [C('K', 'spades'), C('K', 'diamonds')],
];

/**
 * 2026-09-11: production's only equity worker was retired because a job had
 * waited in the queue, again and again, until the respawn budget was spent and
 * the pool stayed 'failed' - live equity and all-in insurance gone for the rest
 * of the process. One total caller SLA now sheds work without touching a worker;
 * only a separate dispatch-scoped hard deadline can retire one.
 */
describe('a queue wait never retires an equity worker (2026-09-11)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sheds a burst whose queue deadlines lapse without retiring the worker or spending respawn budget', async () => {
    vi.useFakeTimers();
    const { pool, workers } = scriptedPool({ jobTimeoutMs: 100, respawnBudget: 1 });
    const ready = pool.ready();
    workers[0].ready();
    await ready;

    // Twelve operations arrive at once; the one worker answers each in 30ms.
    const burst = Array.from({ length: 12 }, (_, i) =>
      outcome(pool.estimateEquity(HANDS, [], [], 100, {}, i + 1))
    );
    for (let answered = 0; answered < 3; answered++) {
      await vi.advanceTimersByTimeAsync(30);
      workers[0].answer();
    }
    // t=90: the fourth operation starts with 10ms left in its total caller SLA.
    expect(workers[0].sent).toHaveLength(4);
    // At t=100 the running caller and all queued callers expire. The active
    // worker is preserved, finishes at t=120, and remains available.
    await vi.advanceTimersByTimeAsync(30);
    workers[0].answer();

    const settled = await Promise.all(burst);
    expect(settled.slice(0, 3).map((result) => result.ok)).toEqual([true, true, true]);
    expect(timeoutStage(settled[3])).toBe('execution');
    expect(settled.slice(4).map(timeoutStage)).toEqual(Array(8).fill('queue'));
    // The worker that was busy with somebody else's answer was never touched.
    expect(workers).toHaveLength(1);
    expect(workers[0].terminateCalls).toBe(0);
    expect(workers[0].sent).toHaveLength(4);
    expect(pool.status()).toMatchObject({
      phase: 'ready',
      readyWorkers: 1,
      queueDepth: 0,
      queueExpirations: 8,
      executionTimeouts: 0,
      respawnBudgetRemaining: 1,
      nextRecoveryAt: null,
      lastError: null,
    });

    const next = pool.estimateEquity(HANDS, [], [], 100, {}, 99);
    workers[0].answer();
    await expect(next).resolves.toEqual([0.82, 0.18]);
    await pool.shutdown();
  });

  it('stays up through a sustained surge that used to spend the budget and fail for good', async () => {
    vi.useFakeTimers();
    // Production's shape: one worker, ten respawns, and three seconds of
    // operations arriving three times faster than the worker can answer them.
    const { pool, workers } = scriptedPool(
      { jobTimeoutMs: 100, respawnBudget: 10 },
      { autoReady: true, computeMs: 30 }
    );
    await pool.ready();

    const surge: Array<Promise<Outcome>> = [];
    for (let t = 0; t < 3_000; t += 10) {
      surge.push(outcome(pool.estimateEquity(HANDS, [], [], 100, {}, t + 1)));
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    const settled = await Promise.all(surge);

    expect(pool.status()).toMatchObject({ phase: 'ready', readyWorkers: 1, executionTimeouts: 0 });
    expect(workers).toHaveLength(1);
    expect(workers[0].terminateCalls).toBe(0);
    // The worker answered back to back for the whole surge (3,000ms / 30ms);
    // everything it could not reach in time was shed at the queue.
    const answered = settled.filter((result) => result.ok).length;
    const timedOut = settled.filter((result) => !result.ok);
    expect(answered).toBeGreaterThan(0);
    expect(timedOut.every((result) => timeoutStage(result) !== undefined)).toBe(true);
    expect(pool.status().queueExpirations).toBe(
      timedOut.filter((result) => timeoutStage(result) === 'queue').length
    );
    await pool.shutdown();
  });

  it('retires only a hard hang, cools down after exhaustion, recovers, and clears every timer', async () => {
    vi.useFakeTimers();
    const { pool, workers } = scriptedPool({
      jobTimeoutMs: 100,
      hardJobTimeoutMs: 200,
      respawnBudget: 1,
      recoveryCooldownMs: 500,
      maxRecoveryCooldownMs: 1_000,
    });
    const ready = pool.ready();
    workers[0].ready();
    await ready;

    const firstHang = outcome(pool.estimateInsurance(HANDS, [], 'nlh', false));
    await vi.advanceTimersByTimeAsync(100);
    expect(timeoutStage(await firstHang)).toBe('execution');
    expect(workers[0].terminateCalls).toBe(0);
    expect(pool.status()).toMatchObject({ phase: 'ready', busyWorkers: 1, executionTimeouts: 0 });

    // Only the 200ms dispatch-scoped hard deadline plus one poll turn retires it.
    await vi.advanceTimersByTimeAsync(101);
    expect(workers[0].terminateCalls).toBe(1);
    expect(pool.status()).toMatchObject({
      phase: 'degraded',
      readyWorkers: 0,
      recoveryInFlight: true,
      routingReady: true,
      acceptingWork: false,
      executionTimeouts: 1,
      respawnBudgetRemaining: 0,
      nextRecoveryAt: null,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(workers).toHaveLength(2);
    workers[1].ready();
    expect(pool.status()).toMatchObject({ phase: 'ready', readyWorkers: 1 });

    // With no successful completion to refill the budget, a second hard hang
    // enters the exhausted cooldown and therefore stops routing.
    const secondHang = outcome(pool.estimateEquity(HANDS, []));
    await vi.advanceTimersByTimeAsync(100);
    expect(timeoutStage(await secondHang)).toBe('execution');
    await vi.advanceTimersByTimeAsync(101);
    expect(workers[1].terminateCalls).toBe(1);
    expect(pool.status()).toMatchObject({
      phase: 'failed',
      readyWorkers: 0,
      recoveryInFlight: false,
      routingReady: false,
      acceptingWork: false,
      executionTimeouts: 2,
      respawnBudgetRemaining: 0,
    });
    expect(pool.status().nextRecoveryAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    expect(workers).toHaveLength(3);
    expect(pool.status()).toMatchObject({ recoveryInFlight: true, routingReady: true });
    workers[2].ready();
    const recovered = pool.estimateEquity(HANDS, []);
    workers[2].answer();
    await expect(recovered).resolves.toEqual([0.82, 0.18]);

    await pool.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads an answer that arrived during a main-thread stall before condemning the worker', async () => {
    // Real timers and a real worker: the ordering under test is the event
    // loop's own, which a fake clock does not reproduce.
    const source = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ type: 'READY' });
      parentPort.on('message', (message) => {
        parentPort.postMessage({ type: 'EQUITY_RESULT', id: message.id, equities: [0.5, 0.5] });
      });
    `;
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => new Worker(source, { eval: true }),
      readyTimeoutMs: 5_000,
      jobTimeoutMs: 50,
      hardJobTimeoutMs: 100,
      respawnBudget: 0,
    });
    await pool.ready();
    try {
      // Ask from the check phase, then hold the main thread well past the
      // caller and hard budgets. The worker answers at once, and its answer
      // waits on the port: the next loop turn expires the caller, then reads
      // the answer (poll), then reaches the hard-deadline grace (check).
      let pending!: Promise<number[]>;
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          pending = pool.estimateEquity(HANDS, [], [], 100, {}, 11);
          const until = Date.now() + 400;
          while (Date.now() < until) {
            // The main thread is busy elsewhere, as it was thawing 955 tables.
          }
          resolve();
        });
      });
      await expect(pending).rejects.toThrow('timed out after 50ms');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pool.status()).toMatchObject({
        phase: 'ready',
        readyWorkers: 1,
        busyWorkers: 0,
        executionTimeouts: 0,
      });
    } finally {
      await pool.shutdown();
    }
  });

  it('keeps insurance ahead of cosmetic equity and sheds the equity that waited too long', async () => {
    vi.useFakeTimers();
    const { pool, workers } = scriptedPool({ jobTimeoutMs: 100, respawnBudget: 0 });
    const ready = pool.ready();
    workers[0].ready();
    await ready;

    const running = outcome(pool.estimateEquity(HANDS, [], [], 100, {}, 1));
    const cosmeticOne = outcome(pool.estimateEquity(HANDS, [], [], 100, {}, 2));
    const cosmeticTwo = outcome(pool.estimateEquity(HANDS, [], [], 100, {}, 3));
    await vi.advanceTimersByTimeAsync(50);
    const insurance = outcome(pool.estimateInsurance(HANDS, [], 'nlh', false));
    await vi.advanceTimersByTimeAsync(10);
    workers[0].answer();
    // t=60: insurance, asked for last, starts ahead of both older cosmetic operations.
    expect(workers[0].sent.map((message) => message.type)).toEqual(['EQUITY', 'INSURANCE_ALL']);
    // t=100 sheds the cosmetic pair; the newer pricing caller still has time.
    await vi.advanceTimersByTimeAsync(60);
    workers[0].answer();

    expect((await running).ok).toBe(true);
    expect((await insurance).ok).toBe(true);
    expect([await cosmeticOne, await cosmeticTwo].map(timeoutStage)).toEqual(['queue', 'queue']);
    expect(workers[0].sent).toHaveLength(2);
    expect(workers[0].terminateCalls).toBe(0);
    expect(pool.status()).toMatchObject({ phase: 'ready', queueExpirations: 2 });
    await pool.shutdown();
  });
});

/**
 * 2026-09-11: a spent respawn budget used to be permanent - nothing ever spawned
 * a worker again until the process restarted. It is a cooldown now.
 */
describe('a spent equity pool recovers on its own (2026-09-11)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cools down once the respawn budget is spent, then refills it and serves again', async () => {
    vi.useFakeTimers();
    const { pool, workers } = scriptedPool({
      respawnBudget: 1,
      recoveryCooldownMs: 1_000,
      maxRecoveryCooldownMs: 4_000,
    });
    const ready = pool.ready();
    workers[0].ready();
    await ready;

    // The only worker dies, and so does its one respawn: the budget is spent.
    workers[0].exit(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(workers).toHaveLength(2);
    workers[1].exit(1);
    const spentAt = Date.now();
    expect(pool.status()).toMatchObject({ phase: 'failed', readyWorkers: 0 });
    // While it cools down, work is refused at once: never queued, never computed here.
    await expect(pool.estimateEquity(HANDS, [])).rejects.toBeInstanceOf(
      EquityWorkerUnavailableError
    );
    const cooling = pool.status();

    await vi.advanceTimersByTimeAsync(999);
    expect(workers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    // The cooldown is over: the budget is refilled and the pool spawns back to size.
    expect(workers).toHaveLength(3);
    workers[2].ready();
    expect(pool.status()).toMatchObject({
      phase: 'ready',
      readyWorkers: 1,
      recoveries: 1,
      nextRecoveryAt: null,
      respawnBudgetRemaining: 1,
    });
    const priced = pool.estimateInsurance(HANDS, [], 'nlh', false);
    workers[2].answer();
    await expect(priced).resolves.toHaveLength(2);

    // What /health carried while the pool was cooling down.
    expect(cooling).toMatchObject({
      phase: 'failed',
      queueDepth: 0,
      respawnBudgetRemaining: 0,
      nextRecoveryAt: spentAt + 1_000,
      recoveries: 0,
    });
    await pool.shutdown();
  });

  it('doubles the cooldown while recoveries fail and resets it on the first completion', async () => {
    vi.useFakeTimers();
    const { pool, workers } = scriptedPool({
      respawnBudget: 0,
      recoveryCooldownMs: 1_000,
      maxRecoveryCooldownMs: 3_000,
    });
    const ready = pool.ready();
    workers[0].ready();
    await ready;
    const cooldownAfterLosing = (worker: ScriptedEquityWorker): number => {
      worker.exit(1);
      return pool.status().nextRecoveryAt! - Date.now();
    };

    expect(cooldownAfterLosing(workers[0])).toBe(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cooldownAfterLosing(workers[1])).toBe(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cooldownAfterLosing(workers[2])).toBe(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cooldownAfterLosing(workers[3])).toBe(3_000);
    await vi.advanceTimersByTimeAsync(3_000);

    // This recovery completes an operation, so the next loss starts from the base.
    workers[4].ready();
    const served = pool.estimateEquity(HANDS, [], [], 100, {}, 7);
    workers[4].answer();
    await served;
    expect(cooldownAfterLosing(workers[4])).toBe(1_000);
    expect(pool.status().recoveries).toBe(4);
    await pool.shutdown();
  });

  it('retires a replacement that never authors READY, so a hung boot cannot wedge recovery', async () => {
    vi.useFakeTimers();
    const { pool, workers } = scriptedPool({
      readyTimeoutMs: 200,
      respawnBudget: 1,
      recoveryCooldownMs: 1_000,
    });
    const ready = pool.ready();
    workers[0].ready();
    await ready;

    workers[0].exit(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(workers).toHaveLength(2);
    // The replacement boots and never says READY.
    await vi.advanceTimersByTimeAsync(199);
    expect(workers[1].terminateCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[1].terminateCalls).toBe(1);
    expect(pool.status()).toMatchObject({ phase: 'failed', respawnBudgetRemaining: 0 });
    expect(pool.status().lastError).toContain('did not become ready within 200ms');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers).toHaveLength(3);
    workers[2].ready();
    expect(pool.status()).toMatchObject({ phase: 'ready', readyWorkers: 1, recoveries: 1 });
    await pool.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() during the cooldown cancels the recovery and leaves nothing armed', async () => {
    vi.useFakeTimers();
    const { pool, workers } = scriptedPool({ respawnBudget: 0, recoveryCooldownMs: 1_000 });
    const ready = pool.ready();
    workers[0].ready();
    await ready;
    workers[0].exit(1);
    expect(pool.status().nextRecoveryAt).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    await pool.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    expect(pool.status()).toMatchObject({ phase: 'stopped', nextRecoveryAt: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(workers).toHaveLength(1);
    expect(pool.status().phase).toBe('stopped');
  });

  it('stop() while a respawn or a replacement boot is pending leaves nothing armed either', async () => {
    vi.useFakeTimers();
    for (const stopAfterMs of [0, 250]) {
      const { pool, workers } = scriptedPool({ respawnBudget: 1 });
      const ready = pool.ready();
      workers[0].ready();
      await ready;
      workers[0].exit(1);
      // 0ms: the respawn is still waiting. 250ms: its replacement is booting
      // under a READY deadline.
      await vi.advanceTimersByTimeAsync(stopAfterMs);
      expect(workers).toHaveLength(stopAfterMs === 0 ? 1 : 2);
      expect(vi.getTimerCount()).toBe(1);

      await pool.shutdown();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
