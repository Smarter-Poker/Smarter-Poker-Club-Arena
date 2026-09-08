import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Card, CardRank, CardSuit } from '../../types.js';
import { insuranceEquity } from '../InsuranceEquity.js';
import {
  EquityWorkerPool,
  EquityWorkerPoolAbortedError,
  EquityWorkerUnavailableError,
} from './EquityWorkerPool.js';
import { computeInsuranceComponentsForHands } from './equityWorker.js';

const C = (rank: CardRank, suit: CardSuit): Card => ({ rank, suit });

class FakeWorker {
  readonly sent: unknown[] = [];
  terminateCalls = 0;
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 0;
  }

  emitMessage(message: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener(message);
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.get('error') ?? []) listener(error);
  }

  emitExit(code = 1): void {
    for (const listener of this.listeners.get('exit') ?? []) listener(code);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('worker-only multi-hand insurance computation', () => {
  const holdemHands: Card[][] = [
    [C('A', 'spades'), C('A', 'hearts')],
    [C('K', 'spades'), C('K', 'hearts')],
    [C('Q', 'spades'), C('Q', 'hearts')],
  ];

  it('matches the established per-player contract from one shared exact runout pass', () => {
    const board = [C('2', 'clubs'), C('7', 'diamonds'), C('9', 'clubs'), C('J', 'diamonds')];
    const all = computeInsuranceComponentsForHands(holdemHands, board, 'nlh', false);

    expect(all).toHaveLength(holdemHands.length);
    for (let i = 0; i < holdemHands.length; i++) {
      const established = insuranceEquity(
        holdemHands[i],
        holdemHands.filter((_, index) => index !== i),
        board,
        'nlh',
        false
      );
      expect(all[i]).toEqual(established);
    }
  });

  it('matches sampled preflop pricing and preserves one deterministic board stream', () => {
    const hands = holdemHands.slice(0, 2);
    const all = computeInsuranceComponentsForHands(hands, [], 'nlh', false);
    for (let i = 0; i < hands.length; i++) {
      expect(all[i]).toEqual(
        insuranceEquity(
          hands[i],
          hands.filter((_, index) => index !== i),
          [],
          'nlh',
          false
        )
      );
    }
    expect(all[0].exact).toBe(false);
    expect(all[0].runouts).toBe(6000);
  });

  it('uses the Omaha and short-deck evaluators, not Holdem defaults', () => {
    const omahaHands: Card[][] = [
      [C('A', 'spades'), C('A', 'hearts'), C('2', 'clubs'), C('3', 'clubs')],
      [C('K', 'spades'), C('K', 'hearts'), C('Q', 'clubs'), C('J', 'clubs')],
    ];
    const omahaBoard = [C('4', 'spades'), C('5', 'hearts'), C('9', 'diamonds'), C('T', 'diamonds')];
    const omaha = computeInsuranceComponentsForHands(omahaHands, omahaBoard, 'plo4', false);
    expect(omaha[0]).toEqual(
      insuranceEquity(omahaHands[0], [omahaHands[1]], omahaBoard, 'plo4', false)
    );

    const shortHands = holdemHands.slice(0, 2);
    const shortBoard = [C('6', 'clubs'), C('7', 'diamonds'), C('9', 'clubs'), C('J', 'diamonds')];
    const short = computeInsuranceComponentsForHands(shortHands, shortBoard, 'short_deck', true);
    expect(short[0]).toEqual(
      insuranceEquity(shortHands[0], [shortHands[1]], shortBoard, 'short_deck', true)
    );
  });

  it('normalizes uppercase and fixed-limit Omaha variants through canonical rules', () => {
    const hands: Card[][] = [
      [C('A', 'spades'), C('A', 'hearts'), C('2', 'clubs'), C('3', 'clubs')],
      [C('K', 'spades'), C('K', 'hearts'), C('Q', 'clubs'), C('J', 'clubs')],
    ];
    const board = [C('4', 'spades'), C('5', 'hearts'), C('9', 'diamonds'), C('T', 'diamonds')];
    const expected = insuranceEquity(hands[0], [hands[1]], board, 'plo8', false);
    expect(computeInsuranceComponentsForHands(hands, board, 'FLO8', false)[0]).toEqual(expected);
    expect(computeInsuranceComponentsForHands(hands, board, 'PLO4', false)[0]).toEqual(expected);
  });
});

describe('EquityWorkerPool fail-closed lifecycle', () => {
  const hands: Card[][] = [
    [C('A', 'spades'), C('A', 'hearts')],
    [C('K', 'spades'), C('K', 'hearts')],
  ];

  it('does not call a synchronous calculator when workers are disabled', async () => {
    const pool = new EquityWorkerPool({ disabled: true });
    await expect(pool.ready()).rejects.toBeInstanceOf(EquityWorkerUnavailableError);
    await expect(pool.estimateEquity(hands, [])).rejects.toBeInstanceOf(
      EquityWorkerUnavailableError
    );
  });

  it('waits for a worker-authored READY handshake before accepting work', async () => {
    const worker = new FakeWorker();
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => worker,
      readyTimeoutMs: 100,
      respawnBudget: 0,
    });
    const readiness = pool.ready();
    expect(pool.status()).toMatchObject({ phase: 'starting', readyWorkers: 0 });
    expect(worker.sent).toEqual([]);

    worker.emitMessage({ type: 'READY' });
    await expect(readiness).resolves.toMatchObject({ configuredWorkers: 1, readyWorkers: 1 });
    expect(pool.status().phase).toBe('ready');
    await pool.shutdown();
  });

  it('rejects a worker error without executing the job on the authoritative thread', async () => {
    const worker = new FakeWorker();
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => worker,
      readyTimeoutMs: 100,
      respawnBudget: 0,
    });
    const ready = pool.ready();
    worker.emitMessage({ type: 'READY' });
    await ready;

    const result = pool.estimateInsurance(hands, [], 'nlh', false);
    expect(worker.sent.at(-1)).toMatchObject({ type: 'INSURANCE_ALL', hands });
    const requestId = (worker.sent.at(-1) as { id: number }).id;
    worker.emitMessage({ type: 'ERROR', id: requestId, error: 'calculator rejected input' });
    await expect(result).rejects.toThrow('calculator rejected input');
    await pool.shutdown();
  });

  it('rejects an equity result with the wrong hand count or non-finite fraction', async () => {
    const worker = new FakeWorker();
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => worker,
      readyTimeoutMs: 100,
      respawnBudget: 0,
    });
    const ready = pool.ready();
    worker.emitMessage({ type: 'READY' });
    await ready;

    const result = pool.estimateEquity(hands, []);
    const requestId = (worker.sent.at(-1) as { id: number }).id;
    worker.emitMessage({ type: 'EQUITY_RESULT', id: requestId, equities: [Number.NaN] });
    await expect(result).rejects.toThrow('Malformed equity worker response');
    expect(worker.terminateCalls).toBe(1);
    expect(pool.status().phase).toBe('failed');
    await pool.shutdown();
  });

  it('rejects malformed nested insurance components and retires their worker', async () => {
    const worker = new FakeWorker();
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => worker,
      readyTimeoutMs: 100,
      respawnBudget: 0,
    });
    const ready = pool.ready();
    worker.emitMessage({ type: 'READY' });
    await ready;

    const result = pool.estimateInsurance(hands, [], 'nlh', false);
    const requestId = (worker.sent.at(-1) as { id: number }).id;
    worker.emitMessage({
      type: 'INSURANCE_RESULT',
      id: requestId,
      components: [
        { equity: 82, strictLossPct: 18, pushPct: 0, exact: 'yes', runouts: 6000 },
        { equity: 18, strictLossPct: 82, pushPct: 0, exact: false, runouts: 6000 },
      ],
    });
    await expect(result).rejects.toThrow('Malformed insurance worker response');
    expect(worker.terminateCalls).toBe(1);
    expect(pool.status().phase).toBe('failed');
    await pool.shutdown();
  });

  it('bounds queue plus compute time and terminates the wedged worker', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => worker,
      readyTimeoutMs: 100,
      jobTimeoutMs: 25,
      respawnBudget: 0,
    });
    const ready = pool.ready();
    worker.emitMessage({ type: 'READY' });
    await ready;

    const pending = pool.estimateEquity(hands, [], [], 1000);
    const rejection = expect(pending).rejects.toThrow('timed out after 25ms');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(worker.terminateCalls).toBe(1);
    await pool.shutdown();
  });

  it('rejects accepted work and readiness when shutdown wins', async () => {
    const worker = new FakeWorker();
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => worker,
      readyTimeoutMs: 100,
      respawnBudget: 0,
    });
    const ready = pool.ready();
    worker.emitMessage({ type: 'READY' });
    await ready;
    const pending = pool.estimateEquity(hands, []);

    await pool.shutdown();
    await expect(pending).rejects.toBeInstanceOf(EquityWorkerPoolAbortedError);
    expect(pool.status()).toMatchObject({ phase: 'stopped', queueDepth: 0, busyWorkers: 0 });
  });

  it('recovers after its last ready worker dies while respawn budget remains', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      readyTimeoutMs: 1000,
      respawnBudget: 1,
    });
    const ready = pool.ready();
    workers[0].emitMessage({ type: 'READY' });
    await ready;

    workers[0].emitExit(1);
    expect(pool.status().phase).toBe('degraded');
    await vi.advanceTimersByTimeAsync(250);
    expect(workers).toHaveLength(2);
    workers[1].emitMessage({ type: 'READY' });
    expect(pool.status()).toMatchObject({ phase: 'ready', readyWorkers: 1 });
    await pool.shutdown();
  });

  it('runs queued insurance before cosmetic equity and keeps FIFO within each class', async () => {
    const worker = new FakeWorker();
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => worker,
      readyTimeoutMs: 100,
      jobTimeoutMs: 1000,
      respawnBudget: 0,
    });
    const ready = pool.ready();
    worker.emitMessage({ type: 'READY' });
    await ready;

    const active = pool.estimateEquity(hands, [], [], 100, {}, 1);
    const cosmeticOne = pool.estimateEquity(hands, [], [], 100, {}, 2);
    const insuranceOne = pool.estimateInsurance(hands, [], 'nlh', false);
    const insuranceTwo = pool.estimateInsurance(hands, [], 'nlh', false);
    const cosmeticTwo = pool.estimateEquity(hands, [], [], 100, {}, 3);
    const answerActive = () => {
      const sent = worker.sent.at(-1) as { id: number; type: string };
      if (sent.type === 'INSURANCE_ALL') {
        worker.emitMessage({
          type: 'INSURANCE_RESULT',
          id: sent.id,
          components: [
            { equity: 82, strictLossPct: 18, pushPct: 0, exact: false, runouts: 6000 },
            { equity: 18, strictLossPct: 82, pushPct: 0, exact: false, runouts: 6000 },
          ],
        });
      } else {
        worker.emitMessage({ type: 'EQUITY_RESULT', id: sent.id, equities: [0.82, 0.18] });
      }
    };

    expect((worker.sent.at(-1) as { type: string }).type).toBe('EQUITY');
    answerActive();
    expect((worker.sent.at(-1) as { type: string }).type).toBe('INSURANCE_ALL');
    answerActive();
    expect((worker.sent.at(-1) as { type: string }).type).toBe('INSURANCE_ALL');
    answerActive();
    expect((worker.sent.at(-1) as { seed: number }).seed).toBe(2);
    answerActive();
    expect((worker.sent.at(-1) as { seed: number }).seed).toBe(3);
    answerActive();

    await Promise.all([active, cosmeticOne, insuranceOne, insuranceTwo, cosmeticTwo]);
    await pool.shutdown();
  });

  it('keeps the main event loop responsive while a worker is CPU-bound', async () => {
    const source = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ type: 'READY' });
      parentPort.on('message', (message) => {
        const until = Date.now() + 120;
        while (Date.now() < until) {}
        parentPort.postMessage({
          type: 'EQUITY_RESULT',
          id: message.id,
          equities: message.hands.map(() => 1 / message.hands.length),
        });
      });
    `;
    const pool = new EquityWorkerPool({
      size: 1,
      workerFactory: () => new Worker(source, { eval: true }),
      readyTimeoutMs: 1000,
      jobTimeoutMs: 1000,
      respawnBudget: 0,
    });
    await pool.ready();

    let ticks = 0;
    const pulse = setInterval(() => ticks++, 10);
    try {
      await pool.estimateEquity(hands, []);
    } finally {
      clearInterval(pulse);
      await pool.shutdown();
    }
    expect(ticks).toBeGreaterThanOrEqual(5);
  });
});

describe('live runout source has no authoritative-thread equity escape', () => {
  it('contains no synchronous calculator import or invocation', () => {
    const pool = readFileSync(new URL('./EquityWorkerPool.ts', import.meta.url), 'utf8');
    const runout = readFileSync(new URL('../ServerTableEngineRunout.ts', import.meta.url), 'utf8');
    const insurance = readFileSync(new URL('../InsuranceEngine.ts', import.meta.url), 'utf8');

    expect(pool).not.toMatch(/\bcomputeEquity\s*\(/);
    expect(pool).not.toMatch(/\bcomputeInsuranceComponentsForHands\s*\(/);
    expect(runout).not.toMatch(/\binsuranceEquity\s*\(/);
    expect(runout).not.toMatch(/\bmonteCarloEquity\s*\(/);
    expect(insurance).not.toMatch(/\binsuranceEquity\s*\(/);
  });

  it('re-proves process, lease, controller, and hand authority after worker pricing', () => {
    const runout = readFileSync(new URL('../ServerTableEngineRunout.ts', import.meta.url), 'utf8');
    expect(runout).toContain('await getEquityPool().estimateInsurance(');
    expect(runout).toMatch(
      /await getEquityPool\(\)\.estimateInsurance\([\s\S]{0,1200}this\.lifecycleCanMutate\(\)[\s\S]{0,400}this\.handController !== controller[\s\S]{0,400}this\.handCount !== pricingHandNumber/
    );
  });
});
