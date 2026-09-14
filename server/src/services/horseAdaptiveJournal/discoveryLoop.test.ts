import { describe, it, expect, vi } from 'vitest';
import { runJournalLoop } from './loop.js';
import type { DiscoveryReceipt } from './discoveryReceipt.js';
const empty = () => ({ status: 'pruned' as const, completedWork: 0, batches: 0, observations: 0 });
describe('isolated discovery scheduling', () => {
  it.each(['unknown', 'idle'] as const)(
    'discovery %s backoff leaves capture and journal progressing without concurrent RPC cycles',
    async (status) => {
      const stop = new AbortController(),
        events: string[] = [],
        times: number[] = [];
      let now = 0,
        turns = 0,
        busy = false;
      const operation = async (name: string) => {
        expect(busy).toBe(false);
        busy = true;
        events.push(name);
        await Promise.resolve();
        busy = false;
      };
      await runJournalLoop(stop.signal, {
        processWork: async () => {
          await operation('journal');
          return { status: 'completed', batchKey: 'a'.repeat(64) };
        },
        processCapture: async () => {
          await operation('capture');
          return { status: 'admitted', requestKey: 'b'.repeat(64) };
        },
        discover: async () => {
          times.push(now);
          await operation('discovery');
          return status === 'idle' ? { status, retainedGaps: 0 } : { status };
        },
        prune: async () => {
          await operation('prune');
          return empty();
        },
        now: () => now,
        started: vi.fn(),
        completed: vi.fn(),
        wait: async (ms) => {
          now += ms;
          if (++turns === 100) stop.abort();
        },
      });
      expect(events[0]).toBe('journal');
      expect(events.filter((x) => x === 'capture').length).toBeGreaterThanOrEqual(9);
      expect(events.filter((x) => x === 'journal').length).toBeGreaterThan(75);
      for (let i = 1; i < times.length; i++)
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(status === 'idle' ? 60000 : 10000);
    }
  );
  it('settles an in-flight discovery and starts nothing after shutdown', async () => {
    const stop = new AbortController();
    let release!: (r: DiscoveryReceipt) => void;
    const discover = vi.fn(
        () =>
          new Promise<DiscoveryReceipt>((r) => {
            release = r;
          })
      ),
      work = vi.fn(async () => ({ status: 'idle' as const })),
      completed = vi.fn();
    const task = runJournalLoop(stop.signal, {
      processWork: work,
      discover,
      prune: async () => empty(),
      now: () => 0,
      started: vi.fn(),
      completed,
      wait: async () => {},
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(discover).toHaveBeenCalledTimes(1);
    stop.abort();
    release({ status: 'idle', retainedGaps: 0 });
    await task;
    expect(work).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
  });
  it('rotates all three retention tasks and preserves discovery retention after a failed capture prune', async () => {
    const stop = new AbortController(),
      events: string[] = [];
    let now = 0,
      n = 0;
    await runJournalLoop(stop.signal, {
      processWork: async () => ({ status: 'idle' }),
      prune: async () => {
        events.push('journal');
        return empty();
      },
      pruneCaptures: async () => {
        events.push('capture');
        throw Error('unknown');
      },
      pruneDiscovery: async () => {
        events.push('discovery');
        return { status: 'pruned', epochs: 0, members: 0, segments: 0 };
      },
      now: () => now,
      started: vi.fn(),
      completed: vi.fn(),
      wait: async () => {
        now += 60000;
        if (++n === 4) stop.abort();
      },
    });
    expect(events).toEqual(['journal', 'capture', 'discovery', 'journal']);
  });
});
