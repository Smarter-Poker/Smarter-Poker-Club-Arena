import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => ({ fork: vi.fn(), getPriority: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  fork: launch.fork,
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  getPriority: launch.getPriority,
}));

import {
  HorseLeagueComputeWorkerClient,
  LowPriorityComputeProcess,
  horseLeagueComputeResponseIsValid,
} from './HorseLeagueComputeWorkerClient.js';

class Child extends EventEmitter {
  pid: number | undefined = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  kill = vi.fn((_signal: NodeJS.Signals) => true);
  send = vi.fn();
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

const stores = { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null };
function ready(pid = 1234) {
  return {
    type: 'READY',
    executionNice: 19,
    solverStores: stores,
    executionPriority: {
      version: 1,
      scope: 'linux-thread-group',
      pid,
      leaderStartTicks: '249881547',
      expectedNice: 19,
      bootstrap: { threadCount: 7, observedNice: 19 },
      ready: { threadCount: 11, observedNice: 19 },
    },
  };
}

let child: Child;
let clients: HorseLeagueComputeWorkerClient[];
let originalExecArgv: string[];

beforeEach(() => {
  expect(process.platform).toBe('linux');
  child = new Child();
  clients = [];
  originalExecArgv = process.execArgv;
  launch.fork.mockReset().mockReturnValue(child);
  launch.getPriority.mockReset().mockReturnValue(0);
});

afterEach(async () => {
  process.execArgv = originalExecArgv;
  if (child.exitCode === null && child.signalCode === null) child.exit();
  await Promise.all(clients.map((client) => client.shutdown()));
  vi.useRealTimers();
});

function client(): HorseLeagueComputeWorkerClient {
  const value = new HorseLeagueComputeWorkerClient({
    hydrateSolverStores: false,
    expectedSolverStores: stores,
  });
  // Observe expected failures immediately; individual tests still assert them.
  void value.ready().catch(() => {});
  clients.push(value);
  return value;
}

describe('Horse League dedicated launch and READY contract', () => {
  it('wraps the original module and filtered Node arguments, retaining advanced IPC', () => {
    process.execArgv = [
      '--max-old-space-size=128',
      '-e',
      'should not execute',
      '--input-type=module',
      '--import',
      '/qualified/loader.mjs',
      '--print',
      'also removed',
    ];
    client();
    const [modulePath, args, options] = launch.fork.mock.calls[0];
    expect(modulePath).toMatch(/\/HorseLeagueComputeProcess\.ts$/);
    expect(args).toEqual([]);
    expect(options.execPath).toBe('/usr/bin/nice');
    expect(options.execArgv).toEqual([
      '-n',
      '19',
      '--',
      process.execPath,
      '--max-old-space-size=128',
      '--import',
      '/qualified/loader.mjs',
    ]);
    expect(options.stdio).toEqual(['ignore', 'inherit', 'inherit', 'ipc']);
    expect(options.serialization).toBe('advanced');
    expect(options.env).toEqual({
      ...process.env,
      HORSE_LEAGUE_HYDRATE_SOLVER_STORES: '0',
      EQUITY_GOVERNOR: 'off',
    });
    expect(options).not.toHaveProperty('shell');
    expect(options).not.toHaveProperty('detached');
    expect(launch.fork).toHaveBeenCalledTimes(1);
  });

  it.each([
    [-20, '39'],
    [0, '19'],
    [5, '14'],
    [19, '0'],
  ])('uses a relative adjustment from parent nice %s', (nice, expected) => {
    launch.getPriority.mockReturnValue(nice);
    client();
    expect(launch.fork.mock.calls[0][2].execArgv.slice(0, 3)).toEqual(['-n', expected, '--']);
  });

  it.each([NaN, -21, 20, 1.5])('rejects invalid parent priority %s without spawning', (nice) => {
    launch.getPriority.mockReturnValue(nice);
    expect(() => client()).toThrow(/parent priority/);
    expect(launch.fork).not.toHaveBeenCalled();
  });

  it('requires the full default-process proof even when hydration is disabled', async () => {
    const value = client();
    child.emit('message', { type: 'READY', executionNice: 19, solverStores: stores });
    await expect(value.ready()).rejects.toThrow(/whole-thread priority proof/);
    expect(child.send).not.toHaveBeenCalled();
  });

  it('binds READY to the original child PID', async () => {
    const value = client();
    child.emit('message', ready(999));
    await expect(value.ready()).rejects.toThrow(/matching whole-thread/);
    expect(child.send).not.toHaveBeenCalled();
  });

  it('accepts the matched proof while preserving the solver-store return value', async () => {
    const value = client();
    child.emit('message', ready());
    await expect(value.ready()).resolves.toEqual(stores);
    expect(child.send).not.toHaveBeenCalled();
  });

  it.each([
    { version: 2 },
    { scope: 'leader-only' },
    { pid: 0 },
    { expectedNice: 0 },
    { leaderStartTicks: ' 123' },
    { leaderStartTicks: '0' },
    { leaderStartTicks: '1'.repeat(21) },
    { leaderStartTicks: '18446744073709551616' },
    { bootstrap: { threadCount: 0, observedNice: 19 } },
    { ready: { threadCount: 33, observedNice: 19 } },
    { ready: { threadCount: 11, observedNice: 0 } },
    { ready: { threadCount: 11, observedNice: 19, ignored: true } },
    { unknown: true },
  ])('rejects malformed proof %j', (patch) => {
    const message = ready();
    expect(
      horseLeagueComputeResponseIsValid({
        ...message,
        executionPriority: { ...message.executionPriority, ...patch },
      })
    ).toBe(false);
  });

  it('keeps legacy injected-worker READY shape available only through the existing seam', () => {
    expect(horseLeagueComputeResponseIsValid({ type: 'READY', solverStores: stores })).toBe(true);
  });
});

describe('Horse League actual-terminal join bookkeeping (unit model)', () => {
  it('latches an unexpected signal exit before the client reentrant shutdown', async () => {
    const value = client();
    child.exit(null, 'SIGTERM');
    await expect(value.ready()).rejects.toThrow(/exited/);
    await expect(value.shutdown()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('returns the same outstanding shutdown join until actual exit', async () => {
    const value = client();
    child.emit('message', ready());
    await value.ready();
    const first = value.shutdown();
    const second = value.shutdown();
    expect(second).toBe(first);
    let terminal = false;
    void first.then(() => {
      terminal = true;
    });
    await Promise.resolve();
    expect(terminal).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.exit(null, 'SIGTERM');
    await first;
    expect(terminal).toBe(true);
  });

  it('waits for close after spawn failure; error is not a terminal receipt', async () => {
    child.pid = undefined;
    const value = client();
    child.emit('error', new Error('spawn ENOENT'));
    const joined = value.shutdown();
    let terminal = false;
    void joined.then(() => {
      terminal = true;
    });
    await Promise.resolve();
    expect(terminal).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', -2, null);
    await joined;
    expect(terminal).toBe(true);
    await expect(value.ready()).rejects.toThrow('spawn ENOENT');
  });

  it('rejects pre-READY ready/dispatch waiters while still joining actual termination', async () => {
    const value = client();
    const waitingReady = value.ready();
    const waitingDispatch = value.runMatchup({ name: 'never-dispatched', a: {}, b: {} }, 1, 17);
    const joined = value.shutdown();
    await expect(waitingReady).rejects.toThrow('shut down');
    await expect(waitingDispatch).rejects.toThrow('shut down');
    expect(child.send).not.toHaveBeenCalled();
    let terminal = false;
    void joined.then(() => {
      terminal = true;
    });
    await Promise.resolve();
    expect(terminal).toBe(false);
    child.exit(null, 'SIGTERM');
    await joined;
    expect(terminal).toBe(true);
  });

  it('does not mistake a live-child IPC error for termination', async () => {
    const value = client();
    child.emit('spawn');
    child.emit('message', ready());
    await value.ready();
    child.emit('error', new Error('IPC send failed'));
    let terminal = false;
    const joined = value.shutdown().then(() => {
      terminal = true;
    });
    await Promise.resolve();
    expect(terminal).toBe(false);
    child.exit(null, 'SIGTERM');
    await joined;
    expect(terminal).toBe(true);
  });

  it('preserves the 5-second KILL fallback and still waits for actual exit', async () => {
    vi.useFakeTimers();
    const adapter = new LowPriorityComputeProcess(child as unknown as ChildProcess);
    const joined = adapter.terminate();
    expect(adapter.terminate()).toBe(joined);
    let terminal = false;
    void joined.then(() => {
      terminal = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(terminal).toBe(false);
    child.exit(null, 'SIGKILL');
    await joined;
    expect(terminal).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains an unknown outcome when sending either signal throws', async () => {
    vi.useFakeTimers();
    child.kill.mockImplementation(() => {
      throw new Error('signal refused');
    });
    const adapter = new LowPriorityComputeProcess(child as unknown as ChildProcess);
    const joined = adapter.terminate();
    let terminal = false;
    void joined.then(() => {
      terminal = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(terminal).toBe(false);
    child.exit(1);
    await expect(joined).resolves.toBe(1);
  });

  it('recognizes an already signaled child without issuing another kill', async () => {
    child.exit(null, 'SIGKILL');
    const adapter = new LowPriorityComputeProcess(child as unknown as ChildProcess);
    await expect(adapter.terminate()).resolves.toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
