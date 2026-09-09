import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  HorseLeagueComputeRequest,
  HorseLeagueComputeResponse,
} from './HorseLeagueComputeProtocol.js';
import {
  HorseLeagueComputeWorkerClient,
  type HorseLeagueComputeWorkerClientOptions,
} from './HorseLeagueComputeWorkerClient.js';
import { runMatchup } from './HorseLeague.js';

class FakeWorker extends EventEmitter {
  readonly sent: HorseLeagueComputeRequest[] = [];
  terminateCalls = 0;

  postMessage(message: HorseLeagueComputeRequest): void {
    this.sent.push(message);
  }

  message(message: HorseLeagueComputeResponse): void {
    this.emit('message', message);
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 0;
  }

  unref(): void {}
}

const clients = new Set<HorseLeagueComputeWorkerClient>();

function clientFor(
  worker: FakeWorker,
  options: Omit<HorseLeagueComputeWorkerClientOptions, 'workerFactory'> = {}
): HorseLeagueComputeWorkerClient {
  const client = new HorseLeagueComputeWorkerClient({
    workerFactory: () => worker,
    expectedSolverStores: { charts: 0, postflop: 0, postflopV31: 0 },
    readyTimeoutMs: 1_000,
    heartbeatTimeoutMs: 1_000,
    cancelPollMs: 5,
    ...options,
  });
  clients.add(client);
  return client;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...clients].map((client) => client.shutdown()));
  clients.clear();
});

describe('Horse League compute isolation', () => {
  it('will not dispatch analysis until the isolated solver stores are ready', async () => {
    const worker = new FakeWorker();
    const client = clientFor(worker, {
      expectedSolverStores: { charts: 4, postflop: 3, postflopV31: 2 },
    });

    const pending = client.runMatchup({ name: 'capacity', a: {}, b: {} }, 8, 17);
    await Promise.resolve();
    expect(worker.sent).toEqual([]);

    worker.message({
      type: 'READY',
      solverStores: { charts: 4, postflop: 3, postflopV31: 2 },
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(1));
    const command = worker.sent[0];
    expect(command.type).toBe('RUN_MATCHUP');
    if (command.type !== 'RUN_MATCHUP') throw new Error('wrong command');

    worker.message({
      type: 'MATCHUP_RESULT',
      jobId: command.jobId,
      result: {
        matchup: 'capacity',
        hands: 16,
        bb100: 0,
        stderr: 0,
        durationMs: 1,
        illegalActions: 0,
        truncatedStreets: 0,
        candidatePolicyHits: 0,
        candidateExecutionMismatches: 0,
        candidateNodeRoles: [],
        benchmarkComponents: [],
      },
    });
    await expect(pending).resolves.toMatchObject({ matchup: 'capacity', hands: 16 });
  });

  it('fails closed when the worker cannot reproduce the live solver corpus', async () => {
    const worker = new FakeWorker();
    const client = clientFor(worker, {
      expectedSolverStores: { charts: 4, postflop: 3, postflopV31: 2 },
    });
    worker.message({
      type: 'READY',
      solverStores: { charts: 4, postflop: 2, postflopV31: 2 },
    });

    await expect(client.ready()).rejects.toThrow(/postflop=2 expected>=3/);
    expect(worker.terminateCalls).toBe(1);
    expect(worker.sent).toEqual([]);
  });

  it('serializes work and treats a lost worker heartbeat as a terminal failure', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = clientFor(worker, { heartbeatTimeoutMs: 50 });
    worker.message({
      type: 'READY',
      solverStores: { charts: 0, postflop: 0, postflopV31: 0 },
    });
    await client.ready();

    const first = client.runMatchup({ name: 'first', a: {}, b: {} }, 8, 17);
    const firstRejected = expect(first).rejects.toThrow(/stopped heartbeating/);
    await Promise.resolve();
    expect(worker.sent).toHaveLength(1);
    await expect(client.runMatchup({ name: 'overlap', a: {}, b: {} }, 8, 18)).rejects.toThrow(
      /already owns job/
    );

    await vi.advanceTimersByTimeAsync(51);
    await firstRejected;
    expect(worker.terminateCalls).toBe(1);
  });

  it('cancels a running worker job when engine lifecycle authority is lost', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = clientFor(worker, { cancelPollMs: 5 });
    worker.message({
      type: 'READY',
      solverStores: { charts: 0, postflop: 0, postflopV31: 0 },
    });
    await client.ready();

    let current = true;
    const pending = client.runMatchup({ name: 'cancel', a: {}, b: {} }, 8, 19, () => current);
    await Promise.resolve();
    expect(worker.sent[0]?.type).toBe('RUN_MATCHUP');
    const run = worker.sent[0];
    if (run.type !== 'RUN_MATCHUP') throw new Error('wrong command');

    current = false;
    await vi.advanceTimersByTimeAsync(6);
    expect(worker.sent).toContainEqual({ type: 'CANCEL', jobId: run.jobId });

    worker.message({
      type: 'MATCHUP_RESULT',
      jobId: run.jobId,
      result: {
        matchup: 'cancel',
        hands: 0,
        bb100: 0,
        stderr: 0,
        durationMs: 1,
        illegalActions: 0,
        truncatedStreets: 0,
        candidatePolicyHits: 0,
        candidateExecutionMismatches: 0,
        candidateNodeRoles: [],
        benchmarkComponents: [],
      },
    });
    await expect(pending).resolves.toMatchObject({ hands: 0 });
  });

  it('runs the real simulator on a worker while the engine event loop remains responsive', async () => {
    // Vitest executes source TypeScript while production executes compiled
    // JavaScript. Register tsx inside a tiny module-worker bootstrap so this
    // test exercises the same worker entrypoint without relying on a stale
    // checked-out dist/ directory.
    const workerEntry = new URL('./HorseLeagueComputeWorker.ts', import.meta.url).href;
    const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const bootstrap =
      `import { register } from ${JSON.stringify(tsxApi)};` +
      `register(); await import(${JSON.stringify(workerEntry)});`;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
      workerData: { hydrateSolverStores: false },
    });
    const client = new HorseLeagueComputeWorkerClient({
      workerFactory: () => worker,
      hydrateSolverStores: false,
      expectedSolverStores: { charts: 0, postflop: 0, postflopV31: 0 },
      readyTimeoutMs: 15_000,
      heartbeatTimeoutMs: 15_000,
    });
    clients.add(client);

    const matchup = {
      name: 'worker-capacity',
      a: {},
      b: { v12: false },
      mind: 'sandbox' as const,
    };
    const direct = await runMatchup(matchup, 40, 0x5eed);

    const gaps: number[] = [];
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 10);
    try {
      const result = await client.runMatchup(matchup, 40, 0x5eed);
      expect(result.hands).toBe(80);
      expect(result.illegalActions).toBe(0);
      expect({
        matchup: result.matchup,
        hands: result.hands,
        bb100: result.bb100,
        stderr: result.stderr,
        illegalActions: result.illegalActions,
        truncatedStreets: result.truncatedStreets,
      }).toEqual({
        matchup: direct.matchup,
        hands: direct.hands,
        bb100: direct.bb100,
        stderr: direct.stderr,
        illegalActions: direct.illegalActions,
        truncatedStreets: direct.truncatedStreets,
      });
    } finally {
      clearInterval(timer);
    }

    expect(gaps.length).toBeGreaterThan(5);
    expect(Math.max(...gaps)).toBeLessThan(500);
  }, 60_000);

  it('pins production to the worker lane with no synchronous league fallback', () => {
    const source = readFileSync(new URL('./HorseLeague.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export async function runLeague'));
    expect(body).toContain('new HorseLeagueComputeWorkerClient()');
    expect(body).toContain('await compute.runMatchup(');
    expect(body).not.toContain('await runMatchup(');
  });

  it('runs the production league in a verified lowest-priority process', () => {
    const clientSource = readFileSync(
      new URL('./HorseLeagueComputeWorkerClient.ts', import.meta.url),
      'utf8'
    );
    const processSource = readFileSync(
      new URL('./HorseLeagueComputeProcess.ts', import.meta.url),
      'utf8'
    );

    expect(clientSource).toContain('fork(');
    expect(clientSource).toContain('HorseLeagueComputeProcess');
    expect(clientSource).toContain('message.executionNice !== osConstants.priority.PRIORITY_LOW');
    expect(clientSource).not.toContain('new Worker(');
    expect(processSource).toContain('setPriority(0, osConstants.priority.PRIORITY_LOW)');
    expect(processSource).toContain('getPriority(0)');
    expect(processSource).toContain("await import('./HorseLeagueComputeWorker.js')");
  });
});
