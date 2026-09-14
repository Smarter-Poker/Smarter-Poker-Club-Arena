import { describe, it, expect, vi } from 'vitest';
import { runJournalLoop } from './loop.js';
import type { ObservationCaptureResult } from '../HorseObservationCapture.js';
const empty = () => ({ status: 'pruned' as const, completedWork: 0, batches: 0, observations: 0 });
describe('isolated acquisition scheduling', () => {
  it.each(['idle', 'deferred'] as const)(
    'a fair %s acquisition preserves journal progress and bounded waits',
    async (status) => {
      const stop = new AbortController(),
        waits: number[] = [],
        work = vi.fn(async () => ({ status: 'completed' as const, batchKey: 'a'.repeat(64) }));
      let turns = 0;
      await runJournalLoop(stop.signal, {
        processWork: work,
        processCapture: async () =>
          status === 'idle'
            ? { status }
            : { status, requestKey: 'b'.repeat(64), reason: 'queue_full' },
        prune: async () => empty(),
        now: () => 0,
        started: vi.fn(),
        completed: vi.fn(),
        wait: async (ms) => {
          waits.push(ms);
          if (++turns === 20) stop.abort();
        },
      });
      expect(work).toHaveBeenCalledTimes(18);
      expect(waits[8]).toBe(status === 'idle' ? 1000 : 2000);
      expect(waits[17]).toBe(status === 'idle' ? 1000 : 4000);
    }
  );
  it.each(['completed', 'deferred', 'quarantined'] as const)(
    'reaches pending acquisition while journal work stays continuously %s',
    async (status) => {
      const stop = new AbortController(),
        events: string[] = [],
        delays: number[] = [];
      let turns = 0;
      await runJournalLoop(stop.signal, {
        processWork: async () => {
          events.push('journal');
          return { status, batchKey: 'a'.repeat(64) };
        },
        processCapture: async () => {
          events.push('capture');
          return { status: 'admitted', requestKey: 'b'.repeat(64) };
        },
        prune: async () => empty(),
        now: () => 0,
        started: vi.fn(),
        completed: vi.fn(),
        wait: async (ms) => {
          delays.push(ms);
          if (++turns === 20) stop.abort();
        },
      });
      expect(events.indexOf('capture')).toBeGreaterThan(0);
      expect(events.indexOf('capture')).toBeLessThanOrEqual(8);
      expect(events.filter((e) => e === 'capture')).toHaveLength(2);
      expect(events.filter((e) => e === 'journal')).toHaveLength(18);
      expect(Math.max(...delays)).toBeLessThanOrEqual(60000);
    }
  );
  it.each(['refined', 'continued', 'captured'] as const)(
    'treats %s as progress without error backoff or journal completion',
    async (status) => {
      const stop = new AbortController(),
        delays: number[] = [],
        cycles: unknown[] = [];
      await runJournalLoop(stop.signal, {
        processWork: async () => ({ status: 'idle' }),
        processCapture: async () => ({ status, requestKey: 'a'.repeat(64) }),
        prune: async () => empty(),
        now: () => 0,
        started: vi.fn(),
        completed: (c) => cycles.push(c),
        wait: async (ms) => {
          delays.push(ms);
          if (delays.length === 4) stop.abort();
        },
      });
      expect(delays).toEqual([1000, 1000, 1000, 1000]);
      expect(cycles[1]).toEqual({ work: 'skipped', retention: 'skipped', acquisition: status });
    }
  );
  it('prioritizes journal work between idle acquisitions and never combines source I/O with maintenance', async () => {
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
