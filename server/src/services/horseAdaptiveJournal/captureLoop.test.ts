import { describe, it, expect, vi } from 'vitest';
import { runJournalLoop } from './loop.js';
import type { ObservationCaptureResult } from '../HorseObservationCapture.js';
const empty = () => ({ status: 'pruned' as const, completedWork: 0, batches: 0, observations: 0 });
describe('isolated acquisition scheduling', () => {
  it('drains journal work before acquisition and never combines source I/O with maintenance', async () => {
    const stop = new AbortController(),
      events: string[] = [],
      cycles: unknown[] = [],
      delays: number[] = [];
    let jobs = 0,
      captures = 0,
      now = 0;
    await runJournalLoop(stop.signal, {
      processWork: async () => {
        events.push('journal');
        return ++jobs === 2
          ? { status: 'completed', batchKey: 'a'.repeat(64) }
          : { status: 'idle' };
      },
      processCapture: async () => {
        events.push('capture');
        return { status: ++captures === 1 ? 'admitted' : 'gap', requestKey: 'b'.repeat(64) };
      },
      prune: async () => {
        events.push('prune');
        return empty();
      },
      readQueueHealth: async () => {
        events.push('health');
        return { status: 'unknown' };
      },
      now: () => now,
      started: vi.fn(),
      completed: (c) => cycles.push(c),
      wait: async (ms) => {
        delays.push(ms);
        now += ms;
        if (delays.length === 5) stop.abort();
      },
    });
    expect(events).toEqual([
      'journal',
      'prune',
      'health',
      'capture',
      'journal',
      'journal',
      'capture',
    ]);
    expect(cycles[1]).toEqual({ work: 'skipped', retention: 'skipped', acquisition: 'admitted' });
    expect(cycles[4]).toEqual({ work: 'skipped', retention: 'skipped', acquisition: 'gap' });
    expect(delays).toEqual([1000, 1000, 1000, 1000, 2000]);
  });
  it('keeps acquisition error backoff across successful empty journal reads', async () => {
    const stop = new AbortController(),
      delays: number[] = [];
    let now = 0;
    await runJournalLoop(stop.signal, {
      processWork: async () => ({ status: 'idle' }),
      processCapture: async () => {
        throw Error('unavailable');
      },
      prune: async () => empty(),
      now: () => now,
      started: vi.fn(),
      completed: vi.fn(),
      wait: async (ms) => {
        delays.push(ms);
        now += ms;
        if (delays.length === 6) stop.abort();
      },
    });
    expect(delays).toEqual([1000, 2000, 1000, 4000, 1000, 8000]);
  });
  it('waits for acquisition to settle and starts no operation after shutdown', async () => {
    const stop = new AbortController();
    let release!: (v: ObservationCaptureResult) => void;
    const processCapture = vi.fn(
      () =>
        new Promise<ObservationCaptureResult>((r) => {
          release = r;
        })
    );
    const processWork = vi.fn(async () => ({ status: 'idle' as const }));
    const completed = vi.fn();
    const task = runJournalLoop(stop.signal, {
      processWork,
      processCapture,
      prune: async () => empty(),
      now: () => 0,
      started: vi.fn(),
      completed,
      wait: async () => {},
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(processCapture).toHaveBeenCalledTimes(1);
    stop.abort();
    release({ status: 'admitted', requestKey: 'a'.repeat(64) });
    await task;
    expect(processWork).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
  });
  it('alternates bounded retention tasks even after one task throws', async () => {
    const stop = new AbortController(),
      calls: string[] = [];
    let now = 0,
      n = 0;
    await runJournalLoop(stop.signal, {
      processWork: async () => ({ status: 'idle' }),
      prune: async () => {
        calls.push('journal');
        return empty();
      },
      pruneCaptures: async () => {
        calls.push('captures');
        throw Error('lost');
      },
      now: () => now,
      started: vi.fn(),
      completed: vi.fn(),
      wait: async () => {
        now += 60000;
        if (++n === 3) stop.abort();
      },
    });
    expect(calls).toEqual(['journal', 'captures', 'journal']);
  });
});
